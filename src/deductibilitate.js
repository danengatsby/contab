'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  TRECEREA DE LA REZULTATUL CONTABIL LA CEL FISCAL (art. 23, 25 si 40^2)
//
//  SURSA UNICA a ajustarilor fiscale. Modulul acopera DOUA feluri de ajustare, care se
//  calculeaza altfel si se greseau altfel:
//    (1) TRATAMENT PE NATURA OPERATIUNII — taxele, sanctiunile/despagubirile si pierderile din
//        creante se clasifica pe linia articolului, nu dupa cont; provizioanele si ajustarile de
//        creante se separa dupa contrapartida si marcajele lor fiscale, plus simetricul la venituri
//        (`NEIMPOZABILE`: reluarea unui provizion nedeductibil nu e venit impozabil);
//    (2) PLAFON — protocol, social, auto, sponsorizare, dobanzi. Partea nedeductibila depinde
//        de o BAZA DE CALCUL, nu de un procent aplicat cheltuielii. Diferenta e intreaga
//        substanta a art. 25: la protocol, 2% NU inseamna „2% e nedeductibil", ci „e deductibil
//        pana la 2% dintr-o baza care include cheltuiala insasi".
//
//  DE CE STAU IMPREUNA: (1) traia in `reporting.js` si era citita DOAR de registrul de evidenta
//  fiscala, iar `accounting.profitTax` — cel care posteaza 691 = 4411 SI alimenteaza D101 —
//  vedea doar (2). Deci registrul spunea un impozit si declaratia depusa altul: pe o amenda de
//  20.000 + provizion 10.000 + impozite nedeductibile 5.000, registrul dadea 16.000 lei impozit
//  si nota contabila 10.400 (-35%). Doua motoare pe aceeasi lege se contrazic garantat; azi e
//  unul singur, iar `registruFiscal` si `profitTax` citesc din el.
//
//  ORDINEA DE APLICARE E PARTE DIN CONTRACT, si e motivul pentru care modulul are DOUA faze:
//    faza 1 (`ajustari`)  — ajustarile care nu depind de impozit: procentele fixe, apoi
//                           protocol, social, auto, sponsorizare (ca CHELTUIALA), dobanzi;
//    faza 2 (`credit`)    — creditul fiscal al sponsorizarii, care depinde de impozitul deja
//                           calculat pe baza fiscala din faza 1.
//  Inversarea fazelor ar da un rezultat plauzibil si gresit: creditul s-ar calcula pe un impozit
//  care inca nu tine cont de nedeductibile.
//
//  Modulul e PUR: primeste cifrele deja agregate (rulaj pe conturi, profit contabil, cifra de
//  afaceri…), nu baza de date. Asta il face testabil direct si independent de driver.
// ─────────────────────────────────────────────────────────────────────────────

const { round2 } = require('./util');
const fiscalRules = require('./fiscalRules');

// Conturile citite de reguli. Prefix, nu potrivire exacta: orice cont poate avea analitice
// (`623.01`), iar o cautare exacta ar rata exact firmele care isi tin analitic cheltuielile.
const CONT = {
  protocol: '623',
  social: '6458',
  salarii: '641',
  sponsorizare: '6582',
  dobanzi: '666',
  venitDobanzi: '766',
};

/** Soldul debitor net al conturilor care incep cu `prefix` (cheltuieli). */
function cheltuiala(rulaj, prefix) {
  let s = 0;
  for (const cod of Object.keys(rulaj || {})) {
    if (String(cod).startsWith(prefix)) s = round2(s + (rulaj[cod].d - rulaj[cod].c));
  }
  return round2(s);
}

/** Soldul creditor net al conturilor care incep cu `prefix` (venituri). */
function venit(rulaj, prefix) {
  let s = 0;
  for (const cod of Object.keys(rulaj || {})) {
    if (String(cod).startsWith(prefix)) s = round2(s + (rulaj[cod].c - rulaj[cod].d));
  }
  return round2(s);
}

/** Un rand de ajustare, in forma pe care o consuma registrul fiscal si D101.
 *  `d101` spune PE CE RAND al formularului 101 se duce ajustarea — cunostinta sta langa temeiul
 *  legal, nu in generatorul XML, fiindca tot aici se schimba daca se schimba regula. */
function rand(regula, temei, cont, baza, plafon, cheltuit, nedeductibil, nota, d101) {
  const r = {
    regula, temei, cont,
    baza: round2(baza), plafon: round2(plafon), cheltuit: round2(cheltuit),
    deductibil: round2(cheltuit - nedeductibil), nedeductibil: round2(nedeductibil),
    nota: nota || '',
  };
  if (d101) r.d101 = d101;
  return r;
}

// Nu mai exista reguli fixe pentru 635/6581/654. Obiectul ramane exportat, gol, pentru ca orice
// extensie sau test vechi care il inspecteaza sa constate explicit ca niciun cont nu decide singur
// tratamentul fiscal. Clasificarile sunt agregate de `profitExpenseTaxonomy.analyze()`.
const FIXE = Object.freeze({});

// ─────────────────────────────────────────────────────────────────────────────
//  PROVIZIOANELE (art. 26 alin. (1) lit. b)
//
//  Regula era `6812: pct 100` — TOATE provizioanele nedeductibile. Dar art. 26 alin. (1) lit. b)
//  face deductibile provizioanele pentru GARANTII DE BUNA EXECUTIE acordate clientilor. Pentru o
//  firma de constructii — profilul caruia aplicatia ii dedica un grup intreg de documente, cu
//  garantii retinute si restituite — asta inseamna impozit pe profit platit in plus, sistematic.
//
//  Ca la 6814, incadrarea NU se poate citi din contul de cheltuiala: 6812 poarta si provizioanele
//  deductibile, si pe cele nedeductibile. Se separa dupa CONTUL DE PROVIZION din contrapartida —
//  alegerea contului 1512 e ea insasi afirmatia contabilului ca provizionul e pentru garantii,
//  exact cum alegerea lui 6581 afirma ca o cheltuiala e o amenda.
//
//  LIMITA pe care aplicatia NU o poate verifica singura: deducerea se acorda pentru bunurile
//  livrate, lucrarile executate si serviciile prestate IN CURSUL TRIMESTRULUI, deci cuantumul
//  depinde de livrarile perioadei. Nu se poate deriva din conturi, asa ca nu se plafoneaza automat;
//  se SPUNE in nota randului, ca revizorul sa stie ce ramane de verificat. Un plafon inventat ar fi
//  mai rau decat lipsa lui: ar arata ca o cifra verificata.
// ─────────────────────────────────────────────────────────────────────────────
const PROVIZION_DEDUCTIBIL = '1512'; // garantii de buna executie acordate clientilor

/** E contul de provizion unul deductibil? (prefix: analiticele proprii se aduna la sintetic) */
function provizionDeductibil(cont) {
  return String(cont || '').startsWith(PROVIZION_DEDUCTIBIL);
}

// ─────────────────────────────────────────────────────────────────────────────
//  AJUSTARILE PENTRU DEPRECIEREA CREANTELOR (art. 26 alin. (1) lit. c)
//
//  NU e un procent fix pe cont, si tocmai de aceea a iesit din tabelul `FIXE`. Regula era
//  `6814: pct 70`, adica 30% deducere pe TOT rulajul contului. Dar cei 30% se acorda numai
//  creantelor care indeplinesc CUMULATIV trei conditii: peste 270 de zile de la scadenta,
//  negarantate de alta persoana, datorate de o persoana neafiliata. Ajustarea contabila se
//  inregistreaza insa mult mai devreme (aplicatia o propune de la 90 de zile, ca judecata de
//  depreciere), deci procentul orb acorda deducere si acolo unde nu exista drept: impozit
//  SUBDECLARAT, adica exact eroarea care se vede abia la control.
//
//  Baza eligibila vine ca marcaj de pe articol (`bazaArt26`, insumat de
//  `reporting.ajustariCreanteArt26`) — la fel ca `cheltAuto` si `cheltLipsaNeimputabila`, fiindca
//  incadrarea nu se poate citi din conturi: acelasi cont poarta si ajustari care se califica, si
//  ajustari care nu. Lipsa marcajului da baza ZERO, deci nedeductibilitate integrala.
// ─────────────────────────────────────────────────────────────────────────────
function ajustariCreante(rulaj, bazaEligibila, cfg, cheltuitCreante) {
  // Suma vine SPARTA pe familii cand apelantul o are (`reporting.ajustariDepreciere`): contul 6814
  // e comun creantelor si stocurilor, iar cele doua se deduc diferit. Fara spargere se cade pe
  // rulajul contului — comportamentul dinainte de a exista ajustarile de stoc.
  const cheltuit = (cheltuitCreante != null && Number.isFinite(Number(cheltuitCreante)))
    ? round2(Number(cheltuitCreante)) : cheltuiala(rulaj, '6814');
  if (cheltuit <= 0) return null;
  const pctDed = Number((cfg || {}).ajustariCreantePct || 0);
  // Baza eligibila nu poate depasi ajustarea inregistrata: altfel un marcaj gresit ar produce o
  // deducere mai mare decat cheltuiala din care se naste.
  const baza = Math.max(0, Math.min(round2(Number(bazaEligibila) || 0), cheltuit));
  const deductibil = round2((baza * pctDed) / 100);
  const nedeductibil = Math.max(0, round2(cheltuit - deductibil));
  const r = rand('Ajustari pentru deprecierea creantelor', 'Art. 26(1)(c)', '6814',
    baza, deductibil, cheltuit, nedeductibil,
    baza > 0
      ? 'Deductibile ' + pctDed + '% din ajustarea aferenta creantelor eligibile (' + baza + ' lei): peste '
        + (Number((cfg || {}).ajustariCreanteZile) || 270) + ' de zile de la scadenta, negarantate, debitor neafiliat.'
      : 'Integral nedeductibile: nicio creanta confirmata ca indeplinind cumulativ conditiile art. 26 alin. (1) lit. c).',
    D101_FIXE);
  // Proportia nedeductibila ramane pe rand: veniturile din reluare (7814) o OGLINDESC, iar
  // recalcularea ei separat ar putea diverge.
  r.pctNedeductibil = cheltuit > 0 ? round2((nedeductibil / cheltuit) * 100) : 100;
  // `pct` pastreaza forma ISTORICA a randului ({cod, nume, baza, pct, suma}), citita de PDF-ul
  // registrului fiscal si de tabelul din interfata. Aici nu mai e o cota din lege, ci proportia
  // REZULTATA — de aceea exista si `pctNedeductibil`, cu nume care spune ce e.
  r.pct = r.pctNedeductibil;
  r.bazaEligibila = baza;
  return r;
}

/**
 * Ajustarile pentru deprecierea STOCURILOR si a IMOBILIZARILOR — integral nedeductibile.
 *
 * Art. 26 alin. (1) enumera LIMITATIV ajustarile si provizioanele deductibile; deprecierea
 * stocurilor si a imobilizarilor nu se regaseste in enumerare, deci nu se deduce. Simetric, la
 * reluare venitul nu se impoziteaza (art. 23 lit. d) — altfel aceeasi suma ar fi impozitata o data
 * prin nedeductibilitate si a doua oara la reluare.
 *
 * Se calculeaza din sumele SPARTE PE FAMILII, nu din rulajul contului: 6814 e comun cu creantele.
 * `nedeterminat` (linii pe conturi de ajustare nemapate) intra tot aici — tratamentul prudent e
 * nedeductibil, iar o suma pe care motorul n-o poate incadra nu are voie sa aduca deducere.
 */
function ajustariNedeductibile(split) {
  const s = split || {};
  const fam = (k) => ({ cheltuiala: round2(Number((s[k] || {}).cheltuiala) || 0), venit: round2(Number((s[k] || {}).venit) || 0) });
  const stocuri = fam('stocuri'); const imob = fam('imobilizari'); const nedet = fam('nedeterminat');
  const randuri = []; const randuriNeimpozabile = [];
  const adauga = (nume, cont, cheltuit, venit, temei) => {
    if (cheltuit > 0) {
      const r = rand(nume, temei, cont, cheltuit, 0, cheltuit, cheltuit,
        'Integral nedeductibila: nu se regaseste in enumerarea de la art. 26 alin. (1).', D101_FIXE);
      r.pct = 100; // forma ISTORICA a randului: PDF-ul si tabelul din interfata citesc `pct`
      randuri.push(r);
    }
    if (venit > 0) {
      randuriNeimpozabile.push({
        regula: 'Venituri din reluarea ' + nume.toLowerCase(), temei: 'Art. 23(d)',
        cont: String(cont).startsWith('2') ? '7813' : '7814', pct: 100, realizat: venit, neimpozabil: venit,
      });
    }
  };
  adauga('Ajustari pentru deprecierea stocurilor', '6814', stocuri.cheltuiala, stocuri.venit, 'Art. 26(1)');
  adauga('Ajustari pentru deprecierea imobilizarilor', '6813', imob.cheltuiala, imob.venit, 'Art. 26(1)');
  adauga('Ajustari pentru depreciere neincadrate', '6814', nedet.cheltuiala, nedet.venit, 'Art. 26(1)');
  return { randuri, randuriNeimpozabile, total: round2(randuri.reduce((a, r) => a + r.nedeductibil, 0)) };
}

// Simetricul la venituri (art. 23): reluarea unei cheltuieli care NU a fost deductibila nu poate
// fi venit impozabil — altfel suma s-ar impozita o data prin nedeductibilitate si a doua oara la
// reluare. `pct` = cat din venit e NEIMPOZABIL, ales in oglinda cu procentul cheltuielii.
// Gol deliberat: singurele doua venituri simetrice (7812, 7814) au procent VARIABIL, nu fix —
// depinde de cat a fost deductibila cheltuiala din care s-au nascut. Vezi `provizioane` si
// `ajustariCreante`. Tabelul ramane pentru o eventuala regula viitoare cu procent cu adevarat fix.
const NEIMPOZABILE = {};

// 7814 sta separat fiindca procentul lui NU e fix: oglindeste exact partea nedeductibila a
// ajustarii din anul respectiv (vezi `ajustariCreante`). Cand nu s-a inregistrat nicio ajustare —
// deci nu exista proportie de oglindit — reluarea e integral NEIMPOZABILA: fara deducere luata
// candva, impozitarea reluarii ar taxa o suma care n-a fost niciodata scazuta. Perechea implicita
// e deci (cheltuiala integral nedeductibila, venit integral neimpozabil), consistenta prin
// constructie.
//
// LIMITA CUNOSCUTA: proportia e cea a ANULUI CURENT. O reluare din 2027 a unei ajustari
// constituite in 2026, cu alta proportie, se oglindeste cu proportia lui 2027. Urmarirea exacta ar
// cere evidenta pe fiecare creanta a sumei deduse candva; pana atunci, aproximarea e strict mai
// buna decat procentul fix de dinainte si e conservatoare acolo unde conteaza (fara deducere
// inregistrata, reluarea nu se impoziteaza).
const NEIMPOZABIL_RELUARE_CREANTE = { cont: '7814', nume: 'Venituri din reluarea ajustarilor pentru creante (partea nedeductibila)', temei: 'Art. 23(d)' };

// Randul D101 al procentelor fixe. Ramane P33 „Alte cheltuieli nedeductibile" pana cand
// formularul oficial confirma un rand dedicat (provizioanele si ajustarile peste limita au
// probabil unul): validatorul NU poate arbitra — regula R80 cere doar ca P34 sa fie suma de la
// P23 la P33, deci orice repartizare care torna trece. O mapare ghicita ar raporta fals si ar
// trece verde; totalul cinstit la „alte" e mai bun. Vezi nota de la D101_IMPLICIT.
const D101_FIXE = 'P33';

/** Tratamentele explicite ale cheltuielilor din 635/6581/654.
 * `treatment.classified` este reconcilierea pe LINII contabile. Lipsurile raman separat in
 * `unresolved`: nu sunt presupuse nici deductibile, nici nedeductibile si blocheaza calculul final
 * la nivelul apelantului. */
function fixe(rulaj, treatment) {
  const randuri = [];
  for (const row of ((treatment && treatment.classified) || [])) {
    const cheltuit = round2(Number(row.amount) || 0);
    if (cheltuit <= 0) continue;
    const pct = Number(row.pctNedeductibil) || 0;
    const nedeductibil = round2((cheltuit * pct) / 100);
    const r = rand(row.label, row.legalBasis, row.account, cheltuit, round2(cheltuit - nedeductibil), cheltuit,
      nedeductibil, pct === 100 ? 'Integral nedeductibila conform clasificarii documentate.'
        : pct > 0 ? 'Nedeductibila in proportie de ' + pct + '% conform clasificarii documentate.'
          : 'Integral deductibila conform clasificarii documentate.',
      D101_FIXE);
    r.pct = pct;
    r.taxCategory = row.category;
    r.entryIds = row.entryIds || [];
    randuri.push(r);
  }
  return { randuri, total: round2(randuri.reduce((s, r) => s + r.nedeductibil, 0)),
    unresolved: (treatment && treatment.unresolved) || [], complete: !treatment || treatment.complete !== false };
}

/**
 * Provizioanele anului, sparte pe deductibile (garantii de buna executie) si nedeductibile.
 *
 * `split` = { deductibile: {cheltuiala, venit}, nedeductibile: {cheltuiala, venit} }, calculat de
 * `reporting.provizioane` dupa contul din contrapartida. Cand lipseste, se cade pe rulajul contului
 * 6812/7812 si TOTUL e nedeductibil — comportamentul de dinainte, adica prudent.
 *
 * SIMETRIA la reluare (art. 23 lit. d) e esentiala si merge in AMBELE sensuri: reluarea unui
 * provizion nedeductibil nu e venit impozabil, dar reluarea unuia DEDUCTIBIL este. Tratate la fel,
 * provizionul de garantii ar fi dedus la constituire si niciodata impozitat la reluare — o
 * deducere definitiva dintr-o operatiune care se anuleaza singura.
 */
function provizioane(split, rulaj) {
  const s = split || null;
  const ded = s ? { cheltuiala: round2(Number(s.deductibile.cheltuiala) || 0), venit: round2(Number(s.deductibile.venit) || 0) }
    : { cheltuiala: 0, venit: 0 };
  const ned = s ? { cheltuiala: round2(Number(s.nedeductibile.cheltuiala) || 0), venit: round2(Number(s.nedeductibile.venit) || 0) }
    : { cheltuiala: cheltuiala(rulaj, '6812'), venit: venit(rulaj, '7812') };
  const randuri = []; const randuriNeimpozabile = [];
  if (ned.cheltuiala > 0) {
    const r = rand('Provizioane pentru riscuri si cheltuieli', 'Art. 26(1)', '6812',
      ned.cheltuiala, 0, ned.cheltuiala, ned.cheltuiala,
      'Integral nedeductibile: nu se regasesc in enumerarea de la art. 26 alin. (1).', D101_FIXE);
    r.pct = 100;
    randuri.push(r);
  }
  if (ded.cheltuiala > 0) {
    // Rand cu nedeductibil ZERO: nu adauga nimic la baza, dar TREBUIE sa apara in registrul fiscal.
    // Un provizion deductibil care lipseste cu totul din registru se citeste ca „nu s-a inregistrat
    // niciun provizion", iar revizorul n-are de unde sti ca a fost recunoscut ca deductibil.
    const r = rand('Provizioane pentru garantii de buna executie (deductibile)', 'Art. 26(1)(b)',
      PROVIZION_DEDUCTIBIL, ded.cheltuiala, ded.cheltuiala, ded.cheltuiala, 0,
      'Deductibile integral. LIMITA neverificata automat: deducerea se acorda pentru bunurile livrate, '
      + 'lucrarile executate si serviciile prestate in cursul trimestrului — cuantumul depinde de livrarile '
      + 'perioadei si se confrunta manual.', D101_FIXE);
    r.pct = 0; // nimic nedeductibil — dar randul APARE, ca revizorul sa vada ce s-a recunoscut
    randuri.push(r);
  }
  if (ned.venit > 0) {
    randuriNeimpozabile.push({ regula: 'Venituri din reluarea provizioanelor nedeductibile', temei: 'Art. 23(d)',
      cont: '7812', pct: 100, realizat: ned.venit, neimpozabil: ned.venit });
  }
  // Reluarea unui provizion DEDUCTIBIL e venit impozabil: nu se adauga niciun rand de scadere.
  return { randuri, randuriNeimpozabile, total: round2(randuri.reduce((a, r) => a + r.nedeductibil, 0)),
    deductibil: ded.cheltuiala, reluareImpozabila: ded.venit };
}

/** Veniturile neimpozabile care se SCAD din baza (nu se aduna).
 *  `pctReluareCreante` = proportia nedeductibila a ajustarii anului, oglindita pe 7814; lipsa ei
 *  inseamna „nicio ajustare inregistrata", deci reluarea e integral neimpozabila. */
function neimpozabile(rulaj, pctReluareCreante, venitReluareCreante) {
  const randuri = [];
  for (const [cod, cfg] of Object.entries(NEIMPOZABILE)) {
    const realizat = venit(rulaj, cod);
    if (realizat <= 0) continue;
    const suma = round2((realizat * cfg.pct) / 100);
    randuri.push({ regula: cfg.nume, temei: cfg.temei, cont: cod, pct: cfg.pct, realizat, neimpozabil: suma });
  }
  // Numai partea de CREANTE a lui 7814: contul poarta si reluarile de ajustari de stoc, care au
  // regimul lor (integral neimpozabile, prin `ajustariNedeductibile`). Fara spargere, o reluare de
  // stoc ar fi oglindita cu proportia creantelor.
  const reluare = (venitReluareCreante != null && Number.isFinite(Number(venitReluareCreante)))
    ? round2(Number(venitReluareCreante)) : venit(rulaj, NEIMPOZABIL_RELUARE_CREANTE.cont);
  if (reluare > 0) {
    const pct = (pctReluareCreante == null || !Number.isFinite(Number(pctReluareCreante)))
      ? 100 : Math.max(0, Math.min(100, Number(pctReluareCreante)));
    randuri.push({
      regula: NEIMPOZABIL_RELUARE_CREANTE.nume, temei: NEIMPOZABIL_RELUARE_CREANTE.temei,
      cont: NEIMPOZABIL_RELUARE_CREANTE.cont, pct, realizat: reluare,
      neimpozabil: round2((reluare * pct) / 100),
    });
  }
  return { randuri, total: round2(randuri.reduce((s, r) => s + r.neimpozabil, 0)) };
}

// ── Maparea pe randurile formularului 101 ─────────────────────────────────────────────────────
// Etichetele si regulile de completare sunt cele din OPANAF 206/2025 (formularul oficial +
// instructiunile lui), NU deduse din numele campurilor. Randurile fara corespondent dedicat merg
// la P33 „Alte cheltuieli nedeductibile" — ceea ce e CORECT, nu o scapare: instructiunea randului
// 33 enumera explicit „depasirile limitelor admisibile, stabilite prin dispozitiile art. 25 alin.
// (3)", adica exact cheltuielile sociale si cele auto.
//
// Validatorul oficial NU poate confirma maparea: regula R80 cere doar ca P34 sa fie suma de la
// P23 la P33, deci ORICE repartizare care torna trece. De aceea sursa e formularul, nu sondajul —
// sondajul a servit doar la aflarea regulilor de aritmetica (R80, R56, R65).
const D101_IMPLICIT = 'P33';

/**
 * Repartizeaza randurile de ajustare pe randurile D101.
 *
 * Amortizarea e singurul caz cu DOUA randuri: formularul cere amortizarea CONTABILA intreaga la
 * P28 (nedeductibila) si pe cea FISCALA la P11 (deducere) — nu diferenta dintre ele. Efectul pe
 * impozit e identic (P34 creste cu `af`, P16 creste cu `af`, deci P35 nu se misca), dar
 * prezentarea e cea ceruta, si trateaza natural si cazul in care amortizarea fiscala o depaseste
 * pe cea contabila — acolo „nedeductibilul" ar fi fost negativ, ceea ce pe formular n-ar avea sens.
 *
 * @returns {{ nedeductibile: object, totalNedeductibil: number, deduceri: object, totalDeduceri: number }}
 */
function mapareD101(randuri) {
  const ned = {}; const ded = {};
  const adauga = (unde, cod, suma) => { if (suma) unde[cod] = round2((unde[cod] || 0) + suma); };
  for (const r of (randuri || [])) {
    const m = r && r.d101;
    if (m && m.brut) {
      // forma „brut + deducere": pe formular merge cheltuiala INTREAGA, iar partea recunoscuta
      // fiscal se scade separat, pe randul de deduceri
      adauga(ned, m.rand, r.cheltuit);
      adauga(ded, m.deducere, r.plafon);
    } else {
      adauga(ned, (m && m.rand) || m || D101_IMPLICIT, r.nedeductibil);
    }
  }
  const sum = (o) => round2(Object.keys(o).reduce((s, k) => s + o[k], 0));
  return { nedeductibile: ned, totalNedeductibil: sum(ned), deduceri: ded, totalDeduceri: sum(ded) };
}

/**
 * FAZA 1 — ajustarile care nu depind de impozitul pe profit.
 *
 * @param {object} i  intrarea agregata:
 *   rulaj             {cod: {d, c}} — rulajul anului pe conturi de venituri/cheltuieli
 *   profitContabil    venituri - cheltuieli (fara 691/698)
 *   cheltAuto         baza cheltuielilor pe vehicule fara uz exclusiv business (marcaj auto50)
 *   cheltImpozitProfit cheltuiala cu impozitul pe profit deja inregistrata (cont 691), daca exista
 *   amortizareFiscala  amortizarea fiscala a anului (baza art. 40^2)
 *   cursEur            cursul de schimb pentru plafonul de 1.000.000 EUR
 * @param {object} cfg cotele (fiscal.FISCAL)
 * @returns {object} `randuri` = TOATE ajustarile nedeductibile (fixe + plafon), in ordinea de
 *   aplicare; `totalNedeductibil` = suma lor — asta se aduna la baza impozabila. Separat,
 *   `randuriNeimpozabile`/`totalNeimpozabil` se SCAD din baza (art. 23), nu se aduna: sunt
 *   venituri, iar amestecarea lor in `randuri` le-ar trimite pe randul gresit din D101.
 */
function ajustari(i, cfg) {
  i = i || {}; cfg = cfg || {};
  const rulaj = i.rulaj || {};

  // ── (1) Procentele fixe, INTAI ────────────────────────────────────────────
  // Nu doar de forma: costul excedentar al indatorarii (art. 40^2, mai jos) se plafoneaza pe o
  // baza care porneste de la rezultatul FISCAL, deci trebuie sa stie deja ce e nedeductibil prin
  // procent fix si ce venit nu se impoziteaza. Calculate dupa, plafonul de 30% ar iesi din alta
  // baza decat cea a registrului fiscal — adica exact divergenta pe care modulul o inchide.
  const fixeRez = fixe(rulaj, i.tratamentCheltuieli);
  // Ajustarile de creante intra tot aici, printre procentele fixe (acelasi rand D101, aceeasi
  // faza), dar cu baza din marcaj, nu cu procent orb. Randul intra in `randuriFixe` ca registrul
  // fiscal sa-l afiseze in acelasi tabel; ordinea fata de neimpozabile conteaza, fiindcă
  // proportia lui nedeductibila e cea oglindita pe 7814.
  // Sumele SPARTE pe familii (creante / stocuri / imobilizari). Cand lipsesc, fiecare regula cade
  // pe rulajul contului — comportamentul de dinainte de a exista ajustarile de stoc.
  const split = i.ajustariDepreciere || null;
  const randCreante = ajustariCreante(rulaj, i.ajustariCreanteBaza, cfg, split ? split.creante.cheltuiala : null);
  if (randCreante) { fixeRez.randuri.push(randCreante); fixeRez.total = round2(fixeRez.total + randCreante.nedeductibil); }
  // Stocurile si imobilizarile: integral nedeductibile, cu simetricul lor la venituri.
  const nedRez = ajustariNedeductibile(split);
  for (const r of nedRez.randuri) { fixeRez.randuri.push(r); fixeRez.total = round2(fixeRez.total + r.nedeductibil); }
  // Provizioanele: 1512 (garantii) deductibile, restul nu. Fara spargere, toate nedeductibile.
  const provRez = provizioane(i.provizioane || null, rulaj);
  for (const r of provRez.randuri) { fixeRez.randuri.push(r); fixeRez.total = round2(fixeRez.total + r.nedeductibil); }
  const neimpRez = neimpozabile(rulaj, randCreante ? randCreante.pctNedeductibil : null,
    split ? split.creante.venit : null);
  for (const r of nedRez.randuriNeimpozabile) { neimpRez.randuri.push(r); neimpRez.total = round2(neimpRez.total + r.neimpozabil); }
  for (const r of provRez.randuriNeimpozabile) { neimpRez.randuri.push(r); neimpRez.total = round2(neimpRez.total + r.neimpozabil); }
  const randuri = fixeRez.randuri.slice(); // randurile cu plafon se adauga in continuare

  // ── Protocol (art. 25(3)(a)) ──────────────────────────────────────────────
  // Baza include cheltuiala de protocol INSASI si cheltuiala cu impozitul pe profit. Un plafon
  // calculat pe profitul contabil simplu ar fi mai mic si ar da nedeductibil in plus.
  const protocol = cheltuiala(rulaj, CONT.protocol);
  if (protocol > 0) {
    const bazaP = round2(Number(i.profitContabil || 0) + protocol + Number(i.cheltImpozitProfit || 0));
    // Baza negativa (an pe pierdere) => plafon 0 => intreaga cheltuiala e nedeductibila.
    const plafonP = bazaP > 0 ? round2((bazaP * Number(cfg.protocolPct || 0)) / 100) : 0;
    randuri.push(rand('Protocol', 'Art. 25(3)(a)', CONT.protocol, bazaP, plafonP, protocol,
      Math.max(0, round2(protocol - plafonP)),
      bazaP > 0 ? '' : 'Baza de calcul <= 0 (an pe pierdere): plafonul e zero, cheltuiala e integral nedeductibila.',
      'P26')); // rd. 26 „Cheltuieli de protocol care depasesc limita prevazuta de lege" — instructiunea citeaza chiar art. 25(3)(a)
  }

  // ── Cheltuieli sociale (art. 25(3)(b)) ────────────────────────────────────
  const social = cheltuiala(rulaj, CONT.social);
  if (social > 0) {
    const fond = cheltuiala(rulaj, CONT.salarii);
    const plafonS = fond > 0 ? round2((fond * Number(cfg.socialPct || 0)) / 100) : 0;
    randuri.push(rand('Cheltuieli sociale', 'Art. 25(3)(b)', CONT.social, fond, plafonS, social,
      Math.max(0, round2(social - plafonS)),
      fond > 0 ? '' : 'Fara fond de salarii: plafonul e zero.',
      'P33')); // fara rand dedicat; instructiunea rd. 33 enumera explicit depasirile de la art. 25(3)
  }

  // ── Cheltuieli auto (art. 25(3)(l)) ───────────────────────────────────────
  // Separat de TVA-ul auto (art. 298, aplicat la inregistrare): acolo se limiteaza TVA-ul
  // deductibil, aici JUMATATE DIN CHELTUIALA. Sunt doua limitari distincte pe acelasi document.
  const auto = round2(Number(i.cheltAuto || 0));
  if (auto > 0) {
    const pctDed = Number(cfg.autoCheltuialaDeductibilPct || 0);
    const treatmentDecision = i.ruleSet
      ? fiscalRules.evaluateTreatment(i.ruleSet, 'ro.profit.vehicle_limited_deduction',
        { expense: auto, exclusiveBusinessUse: false }, i.treatmentOptions)
      : null;
    const dedA = treatmentDecision && treatmentDecision.status === 'computed'
      ? treatmentDecision.result.deductibleExpense : round2((auto * pctDed) / 100);
    const autoRow = rand('Cheltuieli auto', 'Art. 25(3)(l)', '', auto, dedA, auto,
      round2(auto - dedA), 'Deductibile ' + pctDed + '% (vehicule fara utilizare exclusiv business).',
      'P33'); // idem: depasire de la art. 25(3)(l), fara rand propriu pe formular
    if (treatmentDecision) autoRow.treatmentDecision = treatmentDecision;
    randuri.push(autoRow);
  }

  // ── Lipsuri neimputabile din gestiune (art. 25(4)(c)) ─────────────────────
  // Integral nedeductibile cand nu au fost imputate si nu exista contract de asigurare. Baza NU
  // se poate citi din conturi: aceeasi cheltuiala, pe acelasi cont, e deductibila daca lipsa a
  // fost imputata sau acoperita de asigurare. Vine deci ca marcaj de pe articol, la fel ca
  // `cheltAuto` — singura diferenta e ca acolo se limiteaza la 50%, aici la zero.
  const lipsa = round2(Number(i.cheltLipsaNeimputabila || 0));
  if (lipsa > 0) {
    randuri.push(rand('Lipsuri neimputabile din gestiune', 'Art. 25(4)(c)', '', lipsa, 0, lipsa, lipsa,
      'Integral nedeductibile: bunuri constatate lipsa din gestiune, neimputabile si fara contract de asigurare.',
      'P33')); // fara rand dedicat pe formular; instructiunea rd. 33 acopera „alte cheltuieli nedeductibile"
  }

  // ── Sponsorizare, ca CHELTUIALA (art. 25(4)(i)) ───────────────────────────
  // Integral nedeductibila. Beneficiul fiscal nu vine din deducere, ci din CREDITUL de la faza 2 —
  // confuzia intre cele doua e clasica si duce la deducerea sumei de doua ori.
  const sponsor = cheltuiala(rulaj, CONT.sponsorizare);
  if (sponsor > 0) {
    randuri.push(rand('Sponsorizare (cheltuiala)', 'Art. 25(4)(i)', CONT.sponsorizare, sponsor, 0, sponsor,
      sponsor, 'Integral nedeductibila; se recupereaza ca CREDIT FISCAL din impozit (vezi creditul).',
      'P27')); // rd. 27 cere cheltuiala de sponsorizare INREGISTRATA in contabilitate — exact ce e aici
  }

  // ── Amortizare: contabila vs fiscala (art. 28) ────────────────────────────
  // Singura regula care poate produce un nedeductibil NEGATIV, adica o DEDUCERE: cand amortizarea
  // fiscala e mai mare decat cea contabila (cazul accelerata fiscal / liniara contabil, in primul
  // an). Pe toata durata de viata suma diferentelor e zero — ajustarea muta deducerea intre
  // exercitii, nu o creeaza. Forma randului se potriveste exact: „cheltuit" = amortizarea
  // contabila, „deductibil" (plafon) = cea fiscala.
  if (i.amortizare && (Number(i.amortizare.contabila) || Number(i.amortizare.fiscala))) {
    const ac = round2(Number(i.amortizare.contabila) || 0);
    const af = round2(Number(i.amortizare.fiscala) || 0);
    const dif = round2(ac - af);
    if (dif !== 0) {
      randuri.push(rand('Amortizare (contabila vs fiscala)', 'Art. 28', '6811', ac, af, ac, dif,
        dif > 0
          ? 'Amortizarea contabila depaseste pe cea fiscala: diferenta e nedeductibila in acest exercitiu.'
          : 'Amortizarea fiscala depaseste pe cea contabila: diferenta e o DEDUCERE suplimentara (nedeductibil negativ).',
        { rand: 'P28', brut: true, deducere: 'P11' })); // rd. 28 = amortizarea CONTABILA intreaga, rd. 11 = cea FISCALA
    }
  }

  // ── Costuri excedentare ale indatorarii (art. 40^2) ───────────────────────
  // INTERPRETARE (de confirmat de revizor, vezi test/cazuri-aprobate.js): pana la echivalentul a
  // 1.000.000 EUR costul excedentar e deductibil neconditionat; ce depaseste e deductibil doar
  // pana la 30% din baza (rezultat fiscal + costuri excedentare + amortizare fiscala).
  const dob = cheltuiala(rulaj, CONT.dobanzi);
  const vdob = venit(rulaj, CONT.venitDobanzi);
  const excedent = round2(dob - vdob);
  if (excedent > 0) {
    const curs = Number(i.cursEur || 0);
    const plafonEur = curs > 0 ? round2(Number(cfg.dobanziPlafonEur || 0) * curs) : 0;
    let nedeductibilD = 0; let plafonAplicat = plafonEur; let nota = ''; let alternativa = null;
    if (excedent <= plafonEur) {
      nota = 'Sub plafonul de ' + (cfg.dobanziPlafonEur || 0) + ' EUR: integral deductibil.';
    } else {
      // Baza art. 40^2 porneste de la rezultatul FISCAL de dinainte de dobanzi. Apelantul o poate
      // impune (`rezultatFiscalInainteDobanzi`, folosit de corpusul de revizie), dar IMPLICIT o
      // derivam aici din profitul contabil corectat cu ajustarile fixe — asa nu mai depinde de
      // cine cheama functia, si registrul fiscal si nota contabila ajung la aceeasi cifra.
      const rezFiscalAnte = (i.rezultatFiscalInainteDobanzi != null)
        ? Number(i.rezultatFiscalInainteDobanzi) || 0
        : round2(Number(i.profitContabil || 0) + fixeRez.total - neimpRez.total);
      const bazaD = round2(rezFiscalAnte + excedent + Number(i.amortizareFiscala || 0));
      const plafon30 = bazaD > 0 ? round2((bazaD * Number(cfg.dobanziEbitdaPct || 0)) / 100) : 0;
      const peste = round2(excedent - plafonEur);
      // DOUA CITIRI ALE ART. 40^2, ambele calculate — decizia e a revizorului, nu a codului.
      //  A („cumulativ", implicita): plafonul in EUR e deductibil neconditionat, iar cei 30% se
      //     aplica DOAR partii care il depaseste.  ded = plafonEur + min(peste; 30% x baza)
      //  B („alternativa"): deductibilul e maximul dintre cele doua plafoane.
      //     ded = max(plafonEur; 30% x baza)
      // Pe cifre mari diferenta e uriasa, de aceea ambele sunt expuse in rezultat si in cazul
      // PLF-05 din corpusul de revizie. Cand `art402Interpretare === 'max'`, se aplica B.
      const dedA = round2(plafonEur + Math.max(0, Math.min(peste, plafon30)));
      const dedB = round2(Math.max(plafonEur, plafon30));
      const alegeB = String(i.art402Interpretare || cfg.art402Interpretare || 'cumulativ') === 'max';
      plafonAplicat = alegeB ? dedB : dedA;
      nedeductibilD = Math.max(0, round2(excedent - plafonAplicat));
      alternativa = {
        cumulativ: { deductibil: dedA, nedeductibil: Math.max(0, round2(excedent - dedA)) },
        max: { deductibil: dedB, nedeductibil: Math.max(0, round2(excedent - dedB)) },
        aplicata: alegeB ? 'max' : 'cumulativ',
        baza: bazaD, plafonEur, plafon30,
      };
      nota = 'Peste plafonul in EUR. Doua citiri posibile ale art. 40^2 — aplicata: '
        + (alegeB ? 'max(plafon EUR; ' : 'plafon EUR + min(excedent; ') + (cfg.dobanziEbitdaPct || 0)
        + '% din baza ' + round2(bazaD) + ')'
        + '. Cealalta ar da un nedeductibil de '
        + (alegeB ? Math.max(0, round2(excedent - dedA)) : Math.max(0, round2(excedent - dedB)))
        + ' lei. Partea nedeductibila se reporteaza NELIMITAT.';
    }
    const randDob = rand('Costuri excedentare ale indatorarii', 'Art. 40^2', CONT.dobanzi,
      excedent, plafonAplicat, excedent, nedeductibilD, nota,
      'P31'); // rd. 31 — costul excedentar nedeductibil ANUL ACESTA, dar REPORTAT: instructiunea
             // spune ca suma de aici e preluata anul urmator la rd. 12.1, ca deducere
    if (alternativa) randDob.alternativa = alternativa; // ambele cifre, pentru revizor si pentru UI
    randuri.push(randDob);
  }

  const totalNedeductibil = round2(randuri.reduce((s, r) => s + r.nedeductibil, 0));
  return {
    randuri, totalNedeductibil, sponsorizareCheltuita: sponsor,
    // Subseturile, ca registrul fiscal sa poata pastra cele doua tabele SEPARAT in raport fara
    // sa le recalculeze (si deci fara sa poata diverge de la total).
    randuriFixe: fixeRez.randuri, totalFix: fixeRez.total,
    randuriPlafon: randuri.slice(fixeRez.randuri.length),
    totalPlafon: round2(randuri.slice(fixeRez.randuri.length).reduce((s, r) => s + r.nedeductibil, 0)),
    randuriNeimpozabile: neimpRez.randuri, totalNeimpozabil: neimpRez.total,
    tratamentCheltuieli: { complete: fixeRez.complete, unresolved: fixeRez.unresolved },
  };
}

/**
 * FAZA 2 — creditul fiscal al sponsorizarii (art. 25(4)(i)).
 *
 * Plafon = min(procent din cifra de afaceri, procent din impozitul pe profit). Suma disponibila =
 * sponsorizarea anului + reportul neconsumat din anii anteriori, consumat CEL MAI VECHI INTAI
 * (asa se si prescrie). Ce ramane peste `sponsorizareReportAni` ani se pierde.
 *
 * @param {object} i  { cifraAfaceri, impozit, sponsorizareAn, report: [{an, suma}], an }
 * @param {object} cfg cotele
 */
function credit(i, cfg) {
  i = i || {}; cfg = cfg || {};
  const ca = round2(Number(i.cifraAfaceri || 0));
  const impozit = round2(Number(i.impozit || 0));
  const plafonCa = round2((ca * Number(cfg.sponsorizareCaPct || 0)) / 100);
  const plafonImpozit = round2((impozit * Number(cfg.sponsorizareImpozitPct || 0)) / 100);
  const plafon = round2(Math.min(plafonCa, plafonImpozit));

  const anCurent = Number(i.an) || 0;
  const maxAni = Number(cfg.sponsorizareReportAni || 0);
  // Bucket-urile mai vechi decat fereastra de report sunt PRESCRISE: nu se mai pot folosi.
  const toate = (i.report || []).map((r) => ({ an: Number(r.an), suma: round2(Number(r.suma) || 0) }))
    .filter((r) => r.suma > 0);
  const prescrise = toate.filter((r) => anCurent && maxAni && (anCurent - r.an) >= maxAni);
  const utilizabile = toate.filter((r) => !prescrise.includes(r)).sort((a, b) => a.an - b.an);

  const sponsorizareAn = round2(Number(i.sponsorizareAn || 0));
  const disponibil = round2(utilizabile.reduce((s, r) => s + r.suma, 0) + sponsorizareAn);
  const folosit = round2(Math.min(disponibil, Math.max(0, plafon)));

  // Consum FIFO pe ani, ca reportul ramas sa-si pastreze vechimea (altfel prescriptia n-ar mai avea sens).
  let ramas = folosit;
  const reportNou = [];
  for (const b of utilizabile) {
    const ia = Math.min(ramas, b.suma);
    ramas = round2(ramas - ia);
    const rest = round2(b.suma - ia);
    if (rest > 0) reportNou.push({ an: b.an, suma: rest });
  }
  const restAnCurent = round2(sponsorizareAn - ramas);
  if (restAnCurent > 0 && anCurent) reportNou.push({ an: anCurent, suma: restAnCurent });

  return {
    plafonCa, plafonImpozit, plafon, disponibil, folosit,
    reportNou, prescris: round2(prescrise.reduce((s, r) => s + r.suma, 0)),
    impozitDupaCredit: Math.max(0, round2(impozit - folosit)),
  };
}

module.exports = {
  mapareD101, ajustari, credit, fixe, neimpozabile, ajustariCreante, ajustariNedeductibile,
  provizioane, provizionDeductibil, PROVIZION_DEDUCTIBIL,
  CONT, FIXE, NEIMPOZABILE, cheltuiala, venit };
