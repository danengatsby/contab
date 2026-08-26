'use strict';

// Registru de mijloace fixe + amortizare (OMFP 1802/2014, Cod fiscal art. 28, HG 2139/2004).
// Metode: liniara, degresiva (AD1, cu trecere la liniar) si accelerata (50% in primul an).
// Amortizarea incepe din luna URMATOARE punerii in functiune si se inregistreaza lunar
// prin articolul 6811 = 281x (sau 6811 = 280x pentru imobilizari necorporale).

const { round2 } = require('./util');
const coa = require('./chartOfAccounts');
// Plafonul auto (art. 28 alin. (12) lit. m) se rezolva pentru luna fiecarei amortizari.
const fiscal = require('./fiscal');

const METHODS = ['liniara', 'degresiva', 'accelerata'];
function plafonAutoLunar(period) {
  const v = Number(fiscal.rulesAt(period).rates.plafonAmortizareAutoLunar);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONTUL DE AMORTIZARE — harta EXPLICITA, nu concatenare
//
//  Forma veche compunea codul din cifre: `'281' + cont.charAt(2)`. Pentru 2131 si 2133 iesea
//  2813, care exista in plan; pentru construcții (212 -> 2812), mobilier (214 -> 2814) si
//  necorporale (205 -> 2805, 208 -> 2808) ieseau conturi care NU existau. Amortizarea lor se
//  inregistra tacut pe un cont orfan: „(cont necunoscut)" in balanta si in fisa contului, iar
//  <AccountDescription> din SAF-T pleca asa la ANAF. Trecea pentru ca ruta de amortizare scrie
//  direct in `d.entries`, ocolind `composeEntry` — singurul loc care verifica planul si care ar
//  fi REFUZAT articolul.
//
//  O harta nu poate inventa un cod. Ce nu e in ea cade pe sinteticul clasei (280/281), care
//  exista intotdeauna; iar `contAmortizareValid()` spune apelantului daca rezultatul chiar e in
//  plan, ca ruta sa poata refuza inainte de a scrie.
// ─────────────────────────────────────────────────────────────────────────────
const CONT_AMORTIZARE = {
  // necorporale
  201: '2801', 203: '2803', 205: '2805', 206: '2806', 207: '2807', 208: '2808',
  // corporale
  2112: '2811', 212: '2812',
  213: '2813', 2131: '2813', 2132: '2813', 2133: '2813',
  214: '2814', 215: '2815', 216: '2816', 217: '2817',
};

/** Contul de amortizare corespunzator contului de imobilizare (analiticele cad pe sintetic). */
function contAmortizare(cont) {
  const c = String(cont || '');
  if (CONT_AMORTIZARE[c]) return CONT_AMORTIZARE[c];
  // analitic propriu (ex. 2131.01): se cauta sinteticul cel mai lung care se potriveste
  for (let n = c.length - 1; n >= 3; n -= 1) {
    const p = c.slice(0, n);
    if (CONT_AMORTIZARE[p]) return CONT_AMORTIZARE[p];
  }
  return /^20/.test(c) ? '280' : '281'; // sinteticul clasei — exista in plan, nu se inventeaza nimic
}

/** Contul de amortizare, DACA e in planul de conturi. Altfel `null` — apelantul refuza scrierea. */
function contAmortizareValid(cont) {
  const a = contAmortizare(cont);
  return coa.getAccount(a) ? a : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CE NU SE AMORTIZEAZA (art. 28 alin. (4) Cod fiscal, OMFP 1802/2014)
//
//  Nimic nu impiedica azi inregistrarea unui teren ca mijloc fix: 300.000 lei pe 600 de luni
//  produceau 500 lei de cheltuiala pe luna, pe un cont de amortizare. La fel imobilizarile in
//  curs, care nu sunt inca puse in functiune — desi aplicatia stie momentul, are tipul
//  `punere_in_functiune`.
//
//  Sinteticul 211 e RESPINS ca ambiguu, nu tratat ca teren: acopera si terenul (neamortizabil),
//  si amenajarea (amortizabila). Cere analiticul, nu ghici — un teren amortizat si o amenajare
//  neamortizata sunt amandoua erori, iar prefixul nu le poate deosebi.
// ─────────────────────────────────────────────────────────────────────────────
const NEAMORTIZABILE = {
  211: 'Sinteticul 211 acoperă și terenul, și amenajarea. Folosește 2111 (teren, nu se amortizează) sau 2112 (amenajare, se amortizează).',
  2111: 'Terenurile nu sunt active amortizabile (art. 28 alin. (4) Cod fiscal). Se amortizează doar amenajările de terenuri (2112).',
  231: 'Imobilizările în curs de execuție nu se amortizează cât timp nu sunt puse în funcțiune. Înregistrează întâi punerea în funcțiune, apoi mijlocul fix.',
  232: 'Avansurile pentru imobilizări nu se amortizează.',
  233: 'Imobilizările necorporale în curs nu se amortizează cât timp nu sunt puse în funcțiune.',
  234: 'Avansurile pentru imobilizări necorporale nu se amortizează.',
  235: 'Investițiile imobiliare în curs nu se amortizează cât timp nu sunt finalizate.',
};

/** Se poate amortiza contul asta? `{ ok }` sau `{ ok: false, motiv }` — motivul merge la utilizator. */
function esteAmortizabil(cont) {
  const c = String(cont || '').trim();
  if (NEAMORTIZABILE[c]) return { ok: false, motiv: NEAMORTIZABILE[c] };
  // CONTURILE RECTIFICATIVE nu sunt active, ci corectia lor. Regula e pe FAMILIE (28x, 29x), nu pe
  // o lista de coduri: in planul romanesc toata familia are aceasta natura, deci un cont adaugat
  // maine e exclus prin constructie.
  //
  // Garda initiala accepta orice cont de clasa 2 in afara celor enumerate explicit, deci lasa sa
  // treaca si conturile de amortizare, si pe cele de ajustare. Un mijloc fix inregistrat pe 2813
  // producea articolul `6811 = 281` — amortizarea unei amortizari — si intra asa in registru si in
  // sectiunea `Assets` din SAF-T. Suprafata s-a largit cand familia 29x a intrat in plan: exact
  // tiparul „cont nou in plan -> cauta cine il prinde prin prefix".
  if (/^28/.test(c)) return { ok: false, motiv: 'Contul ' + c + ' este un cont de AMORTIZARE (rectificativ), nu un mijloc fix. Înregistrează activul pe contul lui de imobilizare (20x/21x) — contul de amortizare se deduce automat.' };
  if (/^29/.test(c)) return { ok: false, motiv: 'Contul ' + c + ' este un cont de AJUSTARE pentru depreciere (rectificativ), nu un mijloc fix. Înregistrează activul pe contul lui de imobilizare (20x/21x).' };
  // imobilizarile financiare (26x) nu se amortizeaza; nu sunt mijloace fixe deloc
  if (/^26/.test(c)) return { ok: false, motiv: 'Imobilizările financiare (26x) nu se amortizează.' };
  if (/^2[0-9]/.test(c)) return { ok: true };
  return { ok: false, motiv: 'Mijloacele fixe se înregistrează pe un cont de imobilizări (clasa 2).' };
}

// ─────────────────────────────────────────────────────────────────────────────
//  REGIMUL DE AMORTIZARE PERMIS (art. 28 alin. (5) Cod fiscal)
//
//  Alegerea NU e libera, cum era pana acum:
//    a) constructiile              -> numai LINIAR;
//    b) echipamente tehnologice, masini, unelte si instalatii de lucru, computere si
//       echipamente periferice     -> liniar, degresiv sau accelerat;
//    c) orice alt mijloc fix       -> liniar sau degresiv (NU accelerat).
//
//  Punctul b) prinde si computerele, care in planul acesta stau pe 214 impreuna cu mobilierul —
//  iar mobilierul cade la c). Sinteticul nu-i poate deosebi, deci raspunsul se cere EXPLICIT, prin
//  marcajul `computer` de pe activ; acelasi tipar ca `vehiculM1` la plafonul auto: un marcaj gresit
//  schimba impozitul, deci il pune contabilul, nu o euristica pe numarul contului.
//
//  Regula se aplica planului FISCAL la fel ca celui contabil: art. 28 vorbeste despre amortizarea
//  fiscala, iar `metodaFiscala` e exact ea.
// ─────────────────────────────────────────────────────────────────────────────
const TOATE_METODELE = ['liniara', 'degresiva', 'accelerata'];
const FARA_ACCELERATA = ['liniara', 'degresiva'];

function metodePermise(cont, asset) {
  const c = String(cont || '').trim();
  if (/^212/.test(c)) return ['liniara'];                    // constructii
  if (/^213/.test(c)) return TOATE_METODELE.slice();          // echipamente, utilaje, mijloace de transport
  if (asset && asset.computer) return TOATE_METODELE.slice(); // computere si echipamente periferice (214)
  return FARA_ACCELERATA.slice();
}

/** Motivul pentru care metoda nu e permisa pe contul dat (sau `null` daca e in regula). */
function motivMetodaNepermisa(cont, metoda, asset) {
  const permise = metodePermise(cont, asset);
  if (permise.includes(metoda)) return null;
  if (/^212/.test(String(cont || ''))) {
    return 'Construcțiile se amortizează numai liniar (art. 28 alin. (5) lit. a) Cod fiscal).';
  }
  return 'Amortizarea accelerată e permisă doar la echipamente tehnologice, mașini, unelte, instalații de lucru, '
    + 'computere și echipamente periferice (art. 28 alin. (5) lit. b) Cod fiscal). Pentru un computer înregistrat pe '
    + '214, bifează „computer sau echipament periferic".';
}

/** Coeficientul degresiv in functie de durata normala de functionare (ani). */
function degressiveCoef(years) {
  if (years <= 5) return 1.5;
  if (years <= 10) return 2.0;
  return 2.5;
}

/** Prima luna de amortizare = luna urmatoare punerii in functiune (format YYYY-MM). */
function firstDepreciationMonth(dataPif) {
  const d = new Date(dataPif);
  if (isNaN(d)) return null;
  // TOT in UTC. `new Date('2026-01-01')` se parseaza ca miezul noptii UTC, dar `getMonth()` si
  // `getFullYear()` citesc in ora LOCALA — pe un calculator la vest de UTC aceeasi zi devine
  // 31 decembrie, iar amortizarea incepe cu o luna mai devreme. Nu e o subtilitate de test:
  // pachetul Windows ruleaza pe calculatorul clientului, cu fusul lui, deci acelasi mijloc fix
  // s-ar fi amortizat altfel la Bucuresti si altfel la New York. Verificat: TZ=America/New_York
  // dadea prima luna 2026-01 in loc de 2026-02.
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/**
 * Ultima luna in care activul se mai amortizeaza (YYYY-MM), sau null daca nu e limitat.
 *
 * SURSA UNICA a regulii, fiindca era scrisa in doua locuri care se contraziceau: `compute` o citea
 * din `dataCasare` (corect), iar `monthlyDepreciation` sarea peste ORICE activ casat, indiferent
 * de data. Rezultatul: marcarea unui mijloc fix ca fiind casat stergea retroactiv amortizarea
 * lunilor DINAINTE de casare. Registrul arata amortizarea cumulata, dar niciun articol nu o
 * inregistrase — se declansa la orice inchidere intarziata sau regenerare de luna, adica exact
 * cand contabilul marcheaza casarea si abia apoi inchide lunile anterioare.
 *
 * Luna casarii se amortizeaza INCLUSIV (activul a fost in gestiune o parte din ea) — asa numara
 * si `compute`, iar cele doua trebuie sa dea acelasi raspuns despre acelasi activ.
 *
 * Un activ casat FARA data ramane sarit complet: nu se poate sti pana cand s-a amortizat, iar a
 * ghici ar inregistra cheltuiala pe luni in care activul putea sa nu mai existe.
 */
function stopMonth(asset) {
  if (!asset || asset.status !== 'casat') return null;
  return asset.dataCasare ? String(asset.dataCasare).slice(0, 7) : '';
}

/** Cotele anuale de amortizare pentru metoda aleasa. */
function annualQuotas(base, durataLuni, metoda) {
  const years = durataLuni / 12;
  if (metoda === 'accelerata') {
    // 50% in primul an, restul liniar pe durata ramasa
    if (durataLuni <= 12) return [base];
    return null; // tratat la nivel lunar (blocuri inegale)
  }
  if (metoda === 'degresiva') {
    const coef = degressiveCoef(years);
    const degRate = (1 / years) * coef;
    const nYears = Math.ceil(years);
    let remaining = base; const out = [];
    for (let y = 0; y < nYears; y++) {
      const remainingYears = years - y;
      const deg = remaining * degRate;
      const lin = remaining / remainingYears;
      let annual = Math.max(deg, lin); // trecere la liniar cand degresivul scade sub liniar
      annual = Math.min(annual, remaining);
      out.push(annual);
      remaining = remaining - annual;
    }
    return out;
  }
  return null; // liniara
}

// ─────────────────────────────────────────────────────────────────────────────
//  INVESTITIILE ULTERIOARE (modernizari)
//
//  Se putea inregistra un activ nou si se putea casa unul, dar nu se putea MAJORA valoarea unuia
//  existent. O investitie care imbunatateste parametrii tehnici initiali nu e o cheltuiala a lunii:
//  majoreaza valoarea mijlocului fix si se recupereaza prin amortizare (art. 28 alin. (3) Cod
//  fiscal — „investitiile efectuate la [mijloacele fixe amortizabile]" se recupereaza prin
//  deducerea amortizarii). Contabilul avea doua iesiri, amandoua gresite: un activ nou separat
//  (registrul se umple cu fantome, iar casarea reala nu le mai gaseste) sau cheltuiala directa
//  (deducere luata prea devreme, integral, in loc de esalonat).
//
//  REGULA DE RECUPERARE: valoarea investitiei se amortizeaza pe durata normala de utilizare
//  RAMASA, incepand cu luna URMATOARE finalizarii — nu se reia planul de la zero si nu se
//  prelungeste automat durata. Rata lunara creste deci de la luna aceea incolo.
//
//  Pe un activ deja AMORTIZAT INTEGRAL nu mai exista durata ramasa peste care sa se esaloneze;
//  atunci se cere explicit `durataSuplimentaraLuni`. Nu se inventeaza o durata — ar fi o decizie
//  fiscala luata de cod in locul contabilului, exact ce evita si marcajul `vehiculM1`.
// ─────────────────────────────────────────────────────────────────────────────

/** Investitiile unui activ, normalizate si ordonate cronologic. */
function investitii(asset) {
  return ((asset && asset.investitii) || [])
    .map((x) => ({
      id: x.id, data: String(x.data || ''), suma: round2(Number(x.suma) || 0),
      document: x.document || '', descriere: x.descriere || '',
      durataSuplimentaraLuni: Math.max(0, Math.round(Number(x.durataSuplimentaraLuni) || 0)),
    }))
    .filter((x) => x.suma > 0 && /^\d{4}-\d{2}/.test(x.data))
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
}

/** Suma investitiilor ulterioare (majoreaza valoarea de intrare a activului). */
function totalInvestitii(asset) {
  return round2(investitii(asset).reduce((s, x) => s + x.suma, 0));
}

/** Cate luni are planul, cu prelungirile cerute explicit de investitiile de dupa epuizarea lui. */
function durataTotala(asset) {
  const durata = Math.max(1, Number(asset.durataLuni) || 1);
  return durata + investitii(asset).reduce((s, x) => s + x.durataSuplimentaraLuni, 0);
}

/** Planul de amortizare lunar (o linie pe luna), cu inchidere exacta pe valoarea amortizabila. */
function schedule(asset) {
  const cost = round2(Number(asset.cost) || 0);
  const rezidual = round2(Number(asset.valoareReziduala) || 0);
  const durata = Math.max(1, Number(asset.durataLuni) || 1);
  const base = round2(cost - rezidual);
  const metoda = METHODS.includes(asset.metoda) ? asset.metoda : 'liniara';
  const startM = firstDepreciationMonth(asset.dataPif);
  if (!startM) return [];

  // valoarea bruta a fiecarei luni (inainte de rotunjirea de inchidere)
  const monthly = [];
  if (metoda === 'liniara') {
    for (let i = 0; i < durata; i++) monthly.push(base / durata);
  } else if (metoda === 'accelerata' && durata > 12) {
    const firstHalf = (base * 0.5) / 12;
    const rest = (base * 0.5) / (durata - 12);
    for (let i = 0; i < durata; i++) monthly.push(i < 12 ? firstHalf : rest);
  } else if (metoda === 'degresiva') {
    const quotas = annualQuotas(base, durata, 'degresiva');
    for (let i = 0; i < durata; i++) {
      const block = Math.floor(i / 12);
      const blockStart = block * 12;
      const blockMonths = Math.min(12, durata - blockStart);
      monthly.push((quotas[block] || 0) / blockMonths);
    }
  } else {
    for (let i = 0; i < durata; i++) monthly.push(base / durata); // fallback liniar
  }

  // ── Investitiile ulterioare, esalonate pe durata RAMASA ────────────────────────────────────
  // Se aplica peste `monthly`, pe pozitii — nu se reface planul. Asa metoda de amortizare aleasa
  // (degresiva, accelerata) isi pastreaza forma pe partea initiala, iar investitia se adauga
  // liniar peste ea, cum cere recuperarea pe durata ramasa.
  const inv = investitii(asset);
  const luni = [...monthly];
  // Prelungirile cerute explicit se adauga la coada, cu zero, ca sa existe pozitii de umplut.
  const prelungire = inv.reduce((s, x) => s + x.durataSuplimentaraLuni, 0);
  for (let i = 0; i < prelungire; i++) luni.push(0);
  const idxLuna = (per) => {
    const [ay, am] = startM.split('-').map(Number);
    const [by, bm] = String(per).slice(0, 7).split('-').map(Number);
    return (by - ay) * 12 + (bm - am);
  };
  let bazaInv = 0;
  for (const x of inv) {
    // efectul incepe cu luna URMATOARE finalizarii investitiei
    const start = idxLuna(lunaUrmatoare(x.data));
    const from = Math.max(0, start);
    const ramase = luni.length - from;
    if (ramase <= 0) continue; // fara durata ramasa si fara prelungire ceruta: nu se poate esalona
    const rata = x.suma / ramase;
    for (let i = from; i < luni.length; i++) luni[i] += rata;
    bazaInv = round2(bazaInv + x.suma);
  }
  const bazaTotala = round2(base + bazaInv);
  const durataFinala = luni.length;

  const rows = [];
  let cumulat = 0;
  let [y, m] = startM.split('-').map(Number);
  for (let i = 0; i < durataFinala; i++) {
    const last = i === durataFinala - 1;
    const amount = last ? round2(bazaTotala - cumulat) : round2(luni[i]);
    cumulat = round2(cumulat + amount);
    rows.push({ period: y + '-' + String(m).padStart(2, '0'), amount, cumulat, ramas: round2(cost + bazaInv - cumulat) });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return rows;
}

/** Luna urmatoare unei date (YYYY-MM sau YYYY-MM-DD), in UTC — ca `firstDepreciationMonth`. */
function lunaUrmatoare(data) {
  const s = String(data || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(s)) return s;
  let [y, m] = s.split('-').map(Number);
  m += 1; if (m > 12) { m = 1; y += 1; }
  return y + '-' + String(m).padStart(2, '0');
}

/** Valorile calculate la o data de referinta (sfarsitul perioadei `asOf`, YYYY-MM sau data). */
function compute(asset, asOf) {
  // Investitiile ulterioare MAJOREAZA valoarea de intrare, deci intra si in baza amortizabila, si
  // in valoarea ramasa, si in durata (cand au cerut prelungire). Altfel registrul ar raporta un
  // „ramas" mai mic decat realitatea si un activ „integral amortizat" care inca se amortizeaza.
  const inv = totalInvestitii(asset);
  const cost = round2((Number(asset.cost) || 0) + inv);
  const rezidual = round2(Number(asset.valoareReziduala) || 0);
  const durata = durataTotala(asset);
  const base = round2(cost - rezidual);
  const metoda = METHODS.includes(asset.metoda) ? asset.metoda : 'liniara';
  const sch = schedule(asset);
  const refM = String(asOf || new Date().toISOString().slice(0, 7)).slice(0, 7);
  const stopM = stopMonth(asset) || refM;
  const limitM = stopM < refM ? stopM : refM;

  let cumulat = 0; let luni = 0; let current = 0;
  for (const r of sch) {
    if (r.period <= limitM) { cumulat = r.cumulat; luni += 1; }
    if (r.period === refM) current = r.amount;
  }
  return {
    metoda, contAmortizare: contAmortizare(asset.cont),
    bazaAmortizabila: base, amortizareLunara: current || (sch[0] ? sch[0].amount : 0),
    luniAmortizate: luni, durataLuni: durata,
    amortizareCumulata: round2(cumulat), valoareRamasa: round2(cost - cumulat),
    integralAmortizat: luni >= durata,
    // Valoarea de intrare majorata se ARATA separat de costul initial: registrul de mijloace fixe
    // si fisa activului trebuie sa poata explica de unde vine diferenta.
    investitii: inv, valoareIntrare: cost,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PLANUL FISCAL DE AMORTIZARE (art. 28 Cod fiscal)
//
//  Amortizarea fiscala poate folosi ALTA metoda si ALTA durata decat cea contabila (cazul uzual:
//  accelerata fiscal, liniara contabil). Diferenta dintre ele e o ajustare a rezultatului fiscal,
//  in ambele sensuri, si se anuleaza pe toata durata de viata — nu creeaza si nu distruge deducere,
//  o MUTA intre exercitii.
//
//  Planul fiscal e EXTRACONTABIL: nu genereaza articole. Doar planul contabil posteaza 6811 = 281x.
//
//  Nu exista migrare de date, deliberat: `metodaFiscala`/`durataFiscalaLuni` lipsa inseamna
//  „identic cu planul contabil", iar fallback-ul de mai jos o face fara sa scrie nimic. O migrare
//  care ar copia aceleasi valori in fiecare rand ar fi amplificare de scriere pentru zero efect,
//  iar la o schimbare ulterioara a metodei contabile planul fiscal trebuie sa o urmeze cat timp
//  utilizatorul nu l-a fixat explicit — exact ce face fallback-ul.
// ─────────────────────────────────────────────────────────────────────────────

/** Vederea FISCALA a unui mijloc fix: acelasi activ, cu metoda si durata fiscale. */
function fiscalView(asset) {
  const durataF = Number(asset.durataFiscalaLuni);
  return Object.assign({}, asset, {
    metoda: METHODS.includes(asset.metodaFiscala) ? asset.metodaFiscala : asset.metoda,
    durataLuni: Number.isFinite(durataF) && durataF > 0 ? durataF : asset.durataLuni,
  });
}

/** Are activul un plan fiscal DIFERIT de cel contabil? (pentru raportare, nu pentru calcul) */
function hasFiscalPlan(asset) {
  const f = fiscalView(asset);
  return f.metoda !== asset.metoda || Number(f.durataLuni) !== Number(asset.durataLuni);
}

/** Suma amortizarii dintr-un AN, pe planul dat (`schedule` e refolosit, nu reimplementat).
 *  `panaLa` (YYYY-MM) opreste cumularea la finalul unei luni — impozitul pe profit se declara
 *  trimestrial, cumulat de la inceputul anului, deci ajustarea art. 28 trebuie sa poata fi ceruta
 *  si la 31 martie. Fara el, anul intreg (comportamentul istoric). */
function annualFor(asset, year, fiscal, panaLa) {
  const rows = schedule(fiscal ? fiscalView(asset) : asset);
  const limita = panaLa ? String(panaLa).slice(0, 7) : null;
  // Art. 28 alin. (12) lit. m): la vehiculele de persoane cu maxim 9 scaune, amortizarea FISCALA
  // e deductibila cel mult `plafonAmortizareAutoLunar` PE LUNA. Plafonarea se face pe fiecare
  // luna, nu pe total: un an cu 11 luni de amortizare nu primeste plafonul lunii lipsa.
  // Se aplica DOAR planului fiscal — cel contabil ramane intreg (6811 se inregistreaza normal),
  // iar diferenta devine ajustare in registrul fiscal, ca la orice divergenta art. 28.
  let s = 0;
  for (const r of rows) {
    if (!String(r.period).startsWith(String(year))) continue;
    if (limita && String(r.period) > limita) continue;
    const plafon = (fiscal && asset && asset.vehiculM1) ? plafonAutoLunar(r.period) : 0;
    s = round2(s + (plafon > 0 ? Math.min(r.amount, plafon) : r.amount));
  }
  return s;
}

/**
 * Amortizarea contabila vs fiscala a unui an, pe tot registrul (art. 28).
 * `amortizareContabilaReala` (rulajul contului 6811), cand e dat, INLOCUIESTE suma din plan pe
 * partea contabila: registrul fiscal trebuie sa porneasca de la ce s-a inregistrat efectiv, nu de
 * la ce ar fi trebuit sa se inregistreze. Diferenta dintre ele e o problema de contabilitate, nu
 * una fiscala, si nu trebuie ascunsa intr-o ajustare.
 */
function depreciationDifference(assets, year, amortizareContabilaReala, panaLa) {
  let contabilaPlan = 0; let fiscala = 0;
  for (const a of assets || []) {
    contabilaPlan = round2(contabilaPlan + annualFor(a, year, false, panaLa));
    fiscala = round2(fiscala + annualFor(a, year, true, panaLa));
  }
  const contabila = (amortizareContabilaReala != null && Number.isFinite(Number(amortizareContabilaReala)))
    ? round2(Number(amortizareContabilaReala)) : contabilaPlan;
  return {
    contabila, contabilaPlan, fiscala,
    // > 0 => amortizarea contabila e mai mare => partea in plus e NEDEDUCTIBILA;
    // < 0 => amortizarea fiscala e mai mare => deducere suplimentara.
    diferenta: round2(contabila - fiscala),
    areDiferenta: round2(contabila - fiscala) !== 0,
  };
}

/** Amortizarea de inregistrat pentru o luna (pentru toate mijloacele active). */
function monthlyDepreciation(assets, period) {
  const lines = [];
  let total = 0;
  for (const a of assets) {
    // Casarea opreste amortizarea DUPA luna ei, nu retroactiv: lunile dinainte se inregistreaza
    // normal. Acelasi `stopMonth` pe care il foloseste `compute`, ca registrul si articolele sa nu
    // se mai contrazica. Sirul gol = casat fara data => sarit complet (vezi stopMonth).
    const stop = stopMonth(a);
    if (stop !== null && (stop === '' || period > stop)) continue;
    const row = schedule(a).find((r) => r.period === period);
    if (!row || row.amount <= 0) continue;
    lines.push({ assetId: a.id, denumire: a.denumire, cont: a.cont, contAmortizare: contAmortizare(a.cont), suma: row.amount });
    total = round2(total + row.amount);
  }
  return { period, lines, total };
}

/**
 * Neconformitatile unui mijloc fix deja inregistrat, fata de regulile de mai sus.
 *
 * Gardele noi opresc INTRARILE, dar activele scrise inainte de ele raman pe disc si continua sa
 * se amortizeze. Recalcularea lor tacuta ar schimba retroactiv articole deja postate, deci nu se
 * face — se RAPORTEAZA, ca sa poata fi corectate deliberat. Lista goala inseamna „in regula".
 */
function neconformitati(asset) {
  const out = [];
  const am = esteAmortizabil(asset.cont);
  if (!am.ok) out.push(am.motiv);
  const mMet = motivMetodaNepermisa(asset.cont, asset.metoda, asset);
  if (mMet) out.push(mMet);
  const f = fiscalView(asset);
  if (f.metoda !== asset.metoda) {
    const mFisc = motivMetodaNepermisa(asset.cont, f.metoda, asset);
    if (mFisc) out.push('Planul fiscal: ' + mFisc);
  }
  if (!contAmortizareValid(asset.cont)) {
    out.push('Contul de amortizare ' + contAmortizare(asset.cont) + ' nu există în planul de conturi.');
  }
  return out;
}

/** Mijloacele fixe cu valorile calculate la o data (pentru liste/SAF-T). */
function register(db, asOf) {
  return (db.assets || []).map((a) => Object.assign({}, a, {
    contNume: coa.accountName(a.cont),
    calc: compute(a, asOf),
    neconformitati: neconformitati(a),
  }));
}

module.exports = { compute, schedule, monthlyDepreciation, register, contAmortizare, firstDepreciationMonth, degressiveCoef, METHODS,
  fiscalView, hasFiscalPlan, annualFor, depreciationDifference,
  contAmortizareValid, esteAmortizabil, metodePermise, motivMetodaNepermisa, neconformitati,
  investitii, totalInvestitii, durataTotala, lunaUrmatoare,
  CONT_AMORTIZARE, NEAMORTIZABILE };
