'use strict';

// CONTROALE fiscale derivate din PROFIL + date: al treilea pilon (langa declaratii si alerte)
// generat din motorul de profil fiscal. Verifica coerenta datelor cu regimul declarat al firmei
// (neplatitor TVA care colecteaza TVA, micro peste plafon, plafon Intrastat, etc.) si intoarce
// o lista de constatari { nivel: eroare|atentie|info, cod, mesaj }. Pur (peste vederea scoped).

const acc = require('./accounting');
const coa = require('./chartOfAccounts');
const fiscal = require('./fiscal');
const fiscalProfile = require('./fiscalProfile');
const dateFirma = require('./dateFirma');
const profitExpenseTaxonomy = require('./profitExpenseTaxonomy');
const tvaArt310 = require('./tvaArt310');
const microEligibility = require('./microEligibility');
const { period: periodOf, round2 } = require('./util');

const INTRACOM_TYPES = new Set(['livrare_intracomunitara', 'achizitie_intracomunitara']);

/** Rulajul intracomunitar al anului, pe flux: expedieri (livrari, baza clasa 70) si introduceri
 *  (achizitii, valoarea bunurilor vs furnizor 401) — aceeasi extractie ca la D390. */
function intracomTurnover(yearEntries) {
  let expedieri = 0; let introduceri = 0;
  for (const e of yearEntries) {
    if (e.tip === 'livrare_intracomunitara') for (const l of (e.lines || [])) { if (/^70/.test(String(l.credit))) expedieri = round2(expedieri + Number(l.suma || 0)); }
    else if (e.tip === 'achizitie_intracomunitara') for (const l of (e.lines || [])) { if (String(l.credit) === '401') introduceri = round2(introduceri + Number(l.suma || 0)); }
  }
  return { expedieri, introduceri };
}

// Cele doua agregari de venituri de mai jos filtreaza inchiderile 6/7 -> 121 (`resultLines`):
// dupa inchiderea anuala rulajul conturilor de venit se anuleaza, deci ambele cadeau la ZERO si
// controalele dispareau tacit — exact clasa de defect pe care controalele exista sa o prinda.
// O firma cu 500.000 lei cifra de afaceri nu mai era avertizata ca a depasit plafonul de scutire
// TVA, iar micro nu mai era avertizata ca a depasit plafonul de venituri. Un control care tace
// arata identic cu unul care trece.
function venituriClasa7(entries) {
  const r = acc.accumulate(acc.resultLines(entries));
  let venit = 0;
  for (const cod of Object.keys(r)) {
    const a = coa.getAccount(cod);
    if ((a ? a.clasa : Number(String(cod)[0])) === 7) venit = round2(venit + (r[cod].c - r[cod].d));
  }
  return venit;
}

/** Cifra de afaceri CONTABILA neta (conturile 70x: 701-708 minus reducerile 709), folosita de
 *  raportarile financiare. NU este baza fiscala art. 310; aceea este calculata separat, dupa
 *  natura si cronologia operatiunilor, de `tvaArt310`.
 *  Net (credit-debit): 709 (sold debitor) scade automat. */
function cifraAfaceri(entries) {
  const r = acc.accumulate(acc.resultLines(entries));
  let ca = 0;
  for (const cod of Object.keys(r)) if (/^70/.test(String(cod))) ca = round2(ca + (r[cod].c - r[cod].d));
  return ca;
}

/** Ruleaza controalele de coerenta pentru firma (vedere scoped) pe anul `opts.year`. */
/** Cheia de partener folosita in nomenclator: CUI fara prefixul RO si fara separatori. */
function cheiaCui(cui) {
  return String(cui || '').replace(/^ro/i, '').replace(/[^0-9A-Za-z]/g, '');
}

/** Rulajul de ACHIZITIE cu un partener intr-un an: baza (clasele 2/3/6) si TVA dedusa (4426).
 *  Se uita la partenerul de pe ARTICOL, nu la conturi analitice — nomenclatorul e pe CUI. */
function achizitiiPePartener(yearEntries) {
  const pe = {};
  for (const e of yearEntries) {
    const cui = cheiaCui(e.partenerCui);
    if (!cui) continue;
    for (const l of e.lines || []) {
      const suma = Number(l.suma) || 0;
      if (suma <= 0) continue;
      const dcls = String(l.debit || '')[0];
      const p = pe[cui] || (pe[cui] = { baza: 0, tvaDedusa: 0, denumire: e.partener || '' });
      if (String(l.debit || '').startsWith('4426')) p.tvaDedusa = round2(p.tvaDedusa + suma);
      else if (dcls === '2' || dcls === '3' || dcls === '6') p.baza = round2(p.baza + suma);
    }
  }
  return pe;
}

/**
 * Constatarile care se sprijina pe registrul public ANAF (`partner.anaf`, scris de
 * `partnersService.verificaLaAnaf`). Fara verificare nu se poate spune nimic — si ASTA se spune,
 * in loc sa taca: absenta datelor nu e acelasi lucru cu „totul e in regula".
 */
function controalePartener(v, yearEntries, year) {
  const out = [];
  const add = (nivel, cod, mesaj) => out.push({ nivel, cod, mesaj });
  const parteneri = (v || {}).partners || {};
  const achizitii = achizitiiPePartener(yearEntries);
  const cuAchizitii = Object.keys(achizitii).filter((c) => achizitii[c].baza > 0 || achizitii[c].tvaDedusa > 0);
  if (!cuAchizitii.length) return out;

  const neverificati = [];
  for (const cui of cuAchizitii) {
    const p = parteneri[cui];
    const a = p && p.anaf;
    const den = (p && p.den) || achizitii[cui].denumire || cui;
    const sume = achizitii[cui];
    if (!a || !a.verificatLa) { neverificati.push(den); continue; }
    if (a.gasit === false) {
      add('atentie', 'partener-inexistent-anaf',
        'Partenerul „' + den + '" (CUI ' + cui + ') NU există în registrul ANAF, dar are achiziții de '
        + sume.baza + ' lei în ' + year + '. Verifică CUI-ul — o factură de la un cod inexistent nu justifică nici cheltuiala, nici TVA-ul.');
      continue;
    }
    // Art. 11: cheltuielile si TVA-ul de la un contribuabil INACTIV sunt nedeductibile.
    if (a.inactiv) {
      add('eroare', 'partener-inactiv',
        'Partenerul „' + den + '" (CUI ' + cui + ') e declarat INACTIV' + (a.dataInactivare ? ' din ' + a.dataInactivare : '')
        + ', iar în ' + year + ' ai de la el cheltuieli/achiziții de ' + sume.baza + ' lei'
        + (sume.tvaDedusa ? ' și TVA dedusă ' + sume.tvaDedusa + ' lei' : '')
        + '. Art. 11 Cod fiscal: cheltuiala e nedeductibilă și TVA-ul nu se deduce.');
    } else if (a.radiat) {
      add('atentie', 'partener-radiat',
        'Partenerul „' + den + '" (CUI ' + cui + ') e RADIAT (' + (a.stareInregistrare || 'radiat')
        + '), dar are achiziții de ' + sume.baza + ' lei în ' + year + '. Verifică documentele.');
    }
    // TVA dedusa de la cineva care nu e inregistrat in scopuri de TVA.
    if (!a.tvaPlatitor && sume.tvaDedusa > 0) {
      add('eroare', 'tva-dedusa-de-la-neplatitor',
        'Ai dedus TVA de ' + sume.tvaDedusa + ' lei în ' + year + ' pe facturi de la „' + den + '" (CUI ' + cui
        + '), care NU e înregistrat în scopuri de TVA' + (a.tvaMotivAnulare ? ' — ' + a.tvaMotivAnulare : '')
        + '. O factură fără drept de TVA nu poate purta TVA deductibilă.');
    }
    // TVA la incasare la FURNIZOR: deducerea cumparatorului se amana pana la plata.
    if (a.tvaLaIncasare && sume.tvaDedusa > 0) {
      add('info', 'furnizor-tva-la-incasare',
        'Furnizorul „' + den + '" (CUI ' + cui + ') aplică TVA la încasare'
        + (a.tvaIncasareDeLa ? ' din ' + a.tvaIncasareDeLa : '')
        + '. Art. 297 alin. (2): dreptul tău de deducere se amână până la PLATA facturii — '
        + 'folosește tipul „Factură cumpărare cu TVA la încasare", nu pe cel obișnuit.');
    }
  }
  if (neverificati.length) {
    const lista = neverificati.slice(0, 5).join(', ') + (neverificati.length > 5 ? ` și încă ${neverificati.length - 5}` : '');
    add('atentie', 'parteneri-neverificati-anaf',
      neverificati.length + ' partener(i) cu achiziții în ' + year + ' nu au fost verificați în registrul ANAF ('
      + lista + '). Fără verificare nu se poate ști dacă vreunul e inactiv — iar cheltuiala cu un inactiv '
      + 'e nedeductibilă (art. 11). Rulează verificarea din Parteneri.');
  }
  return out;
}

function check(v, opts) {
  opts = opts || {};
  const company = (v || {}).company || {};
  const year = String(opts.year || new Date().getFullYear());
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const microAsOf = opts.period || (year === currentPeriod.slice(0, 4) ? currentPeriod : year);
  const ruleSet = fiscal.rulesAt(year + '-12'); const rates = ruleSet.rates;
  const profile = fiscalProfile.profileAt(v || {}, year, { angajati: (v || {}).angajati });
  const posted = acc.postedEntries(v);
  const yearEntries = posted.filter((e) => String(e.period || periodOf(e.data)).startsWith(year));
  const findings = [];
  const add = (nivel, cod, mesaj, details) => findings.push(Object.assign({ nivel, cod, mesaj },
    details ? { details } : {}));

  const expenseReview = profitExpenseTaxonomy.analyze(posted, year);
  // Controlul micro are propria baza (cifra de afaceri contabila + persoanele legate) si propriul
  // registru de forta de munca. Il calculam o singura data si il expunem integral clientului: lista
  // `findings` e rezumatul actionabil, iar assessment-ul pastreaza operatiunea/data/trimestrul.
  const microAssessment = microEligibility.analyze(v || {}, microAsOf);
  if (!expenseReview.complete) add('eroare', 'cheltuieli-fiscale-neclasificate',
    expenseReview.unresolved.length + ' linie/linii din conturile 635, 6581 sau 654 nu au natura fiscala documentata. '
      + 'Calculul final al impozitului pe profit, D101 si inchiderea anuala sunt blocate pana la clasificare.');

  // 1) Neplatitor TVA dar COLECTEAZA TVA (4427) -> inconsistenta de regim
  if (!profile.tvaPlatitor) {
    const colecteaza = yearEntries.some((e) => (e.lines || []).some((l) => String(l.credit).startsWith('4427') && Number(l.suma) > 0));
    if (colecteaza) add('eroare', 'tva-neplatitor-colecteaza',
      'Firma nu e plătitoare de TVA, dar în ' + year + ' există TVA colectată (cont 4427). Verifică regimul TVA sau facturile emise.');

    // 1b) Plafonul art. 310 se urmareste operatie cu operatie, pe baza FISCALA proprie. Codul TVA
    //     anulat (D311) nu este regim de mica intreprindere si nu intra in aceasta verificare. De la
    //     1 septembrie 2025, chiar tranzactia care depaseste plafonul intra in regim normal si
    //     inregistrarea se solicita cel tarziu in acea zi (OG 22/2025).
    const plafonTva = Number(rates.plafonScutireTvaLei) || 0;
    const art310 = tvaArt310.analyze(posted, year, { threshold: plafonTva });
    if (!profile.tvaCodAnulat && !art310.complete) {
      add('eroare', 'tva-art310-neclasificat',
        art310.unresolved.length + ' operațiune/operațiuni nu au natura fiscală art. 310 documentată. '
        + 'Baza exactă și data depășirii nu pot fi stabilite; controlul plafonului TVA este blocat până la revizuire.',
      { unresolved: art310.unresolved });
    } else if (!profile.tvaCodAnulat && art310.crossing) {
      const c = art310.crossing;
      let obligatie;
      if (c.regime === 'same_day') {
        obligatie = 'Înregistrarea în scopuri de TVA trebuie solicitată cel târziu la data depășirii, '
          + 'iar regimul normal se aplică din ' + c.data + ', începând chiar cu această tranzacție.';
      } else if (c.regime === 'og22_transition_august') {
        obligatie = 'Se aplică regula tranzitorie OG 22/2025: solicitarea și regimul normal au data de 10.09.2025.';
      } else {
        obligatie = 'Este o depășire istorică; verifică îndeplinirea obligației potrivit regulii în vigoare la acea dată.';
      }
      add(c.regime === 'historical_rule' ? 'atentie' : 'eroare', 'tva-plafon-scutire-depasit',
        'Baza fiscală art. 310 a depășit plafonul de ' + c.threshold + ' lei la data de ' + c.data
        + ', prin operațiunea ' + (c.document || c.entryId || c.tip) + ' (de la ' + c.totalBefore
        + ' la ' + c.totalAfter + ' lei). ' + obligatie, c);
    } else if (!profile.tvaCodAnulat && plafonTva > 0 && art310.total > round2(plafonTva * 0.9)) {
      add('info', 'tva-plafon-scutire-aproape',
        'Baza fiscală art. 310 a anului ' + year + ' (' + art310.total + ' lei) se apropie de plafonul de scutire TVA ('
        + plafonTva + ' lei). La depășire, înregistrarea se solicită cel târziu în ziua depășirii, '
        + 'iar tranzacția care conduce la depășire intră în regimul normal.');
    }
  }

  // 2) Platitor TVA fara cod CAEN — D300 il cere.
  // Conditia de „lipsa" vine din `src/dateFirma.js`, aceeasi sursa din care checklistul de
  // pornire decide daca pasul „Completeaza datele firmei" e facut. Inainte erau doua definitii:
  // checklistul se multumea cu CUI-ul si bifa pasul, iar controlul de aici cerea CAEN — deci
  // acelasi ecran spunea „gata" si „mai ai de completat". Regimul (doar platitorii de TVA) ramane
  // aici: modulul spune CE lipseste, controlul spune PENTRU CINE conteaza.
  if (profile.tvaPlatitor && dateFirma.lipsa(company, profile).some((f) => f.camp === 'caen')) {
    add('atentie', 'tva-fara-caen', 'Ești plătitor de TVA, dar codul CAEN nu e completat — decontul D300 îl solicită.');
  }

  // 3–4) Eligibilitate micro 2026: cifra de afaceri contabila, intreprinderi legate si FTE/mandat.
  // Nu mai exista fallback pe clasa 7 sau `angajati.length`: lipsa registrului este o EROARE de
  // revizuire, iar pierderea eligibilitatii este blocanta pentru declaratie.
  if (profile.micro || microEligibility.wasMicroDuringYear(v || {}, year)) {
    const expectedTransition = microAssessment.exit && microAssessment.exit.period.replace(/-Q([1-4])$/, (_, q) => '-'
      + String((Number(q) - 1) * 3 + 1).padStart(2, '0') + '-01');
    const transitionApplied = !!(expectedTransition && fiscalProfile.profileAt(v || {}, expectedTransition).profit);
    const exitLevel = transitionApplied ? 'info' : 'eroare';
    if (!microAssessment.complete) add('eroare', 'micro-eligibilitate-neconfirmata',
      'Eligibilitatea micro nu poate fi stabilită: ' + microAssessment.blockers.map((x) => x.message).join(' '),
      { blockers: microAssessment.blockers });
    if (microAssessment.crossing) {
      const c = microAssessment.crossing;
      add(exitLevel, 'micro-plafon-depasit', 'Cifra de afaceri relevantă cumulată ('
        + microAssessment.combinedRevenue + ' lei: firma ' + microAssessment.ownRevenue + ' + întreprinderi legate '
        + microAssessment.linkedRevenue + ') a depășit plafonul de ' + microAssessment.thresholdEur
        + ' EUR (~' + microAssessment.thresholdLei + ' lei) la ' + c.date + '. Trecerea la impozit pe profit începe în '
        + c.period + '; D100 micro este blocată din acel trimestru.', c);
    }
    if (microAssessment.opening && microAssessment.opening.crossing) {
      const c = microAssessment.opening.crossing;
      add(exitLevel, 'micro-plafon-deschidere-depasit', 'La 31.12.' + microAssessment.opening.year
        + ', cifra de afaceri relevantă cumulată era ' + microAssessment.opening.combinedRevenue
        + ' lei (firma ' + microAssessment.opening.ownRevenue + ' + întreprinderi legate '
        + microAssessment.opening.linkedRevenue + '), peste plafonul de ' + microAssessment.thresholdEur
        + ' EUR (~' + microAssessment.thresholdLei + ' lei). Firma nu este eligibilă micro din '
        + year + '-Q1; operațiunea care a depășit plafonul este din ' + c.date + '.', c);
    }
    if (microAssessment.workforce && microAssessment.workforce.qualifies === false) add(exitLevel,
      'micro-conditie-salariat-neindeplinita', microAssessment.workforce.reason + ' Trecerea la impozit pe profit începe în '
        + microAssessment.workforce.exitPeriod + '.', microAssessment.workforce);
    for (const warning of microAssessment.warnings || []) add('info', 'micro-monitorizare', warning);
    if (microAssessment.exit && !transitionApplied) {
      add('eroare', 'micro-profil-neactualizat',
        'Controlul stabilește trecerea la impozit pe profit din ' + expectedTransition
        + ', dar profilul fiscal este încă micro. Înregistrează revizia înainte de D100/D101.');
    }
  }

  // 5) Intrastat AUTO-DETECT: compara rulajul intracomunitar cu pragurile INS (pe flux). Peste
  //    prag si nemarcat -> obligat (atentie); sub prag dar cu operatiuni -> monitorizeaza (info);
  //    marcat dar sub prag pe ambele fluxuri -> poate iesi din obligatie (info).
  const areIntracom = yearEntries.some((e) => INTRACOM_TYPES.has(e.tip));
  const rulaj = intracomTurnover(yearEntries);
  const pragIntro = Number(rates.pragIntrastatIntroduceri) || 0;
  const pragExp = Number(rates.pragIntrastatExpedieri) || 0;
  const depasesteIntro = pragIntro > 0 && rulaj.introduceri > pragIntro;
  const depasesteExp = pragExp > 0 && rulaj.expedieri > pragExp;
  if (depasesteIntro || depasesteExp) {
    if (!profile.intrastat) {
      const fluxuri = [depasesteIntro ? 'introduceri ' + rulaj.introduceri + ' lei' : null, depasesteExp ? 'expedieri ' + rulaj.expedieri + ' lei' : null].filter(Boolean).join(' și ');
      add('atentie', 'intrastat-prag-depasit',
        'Ai depășit pragul Intrastat (' + fluxuri + ' > ' + pragIntro + ' lei) în ' + year + ' — ești OBLIGAT la declarația Intrastat. Bifează „Obligată la Intrastat".');
    }
  } else if (areIntracom && !profile.intrastat) {
    add('info', 'intracom-sub-prag',
      'Ai operațiuni intracomunitare în ' + year + ' (introduceri ' + rulaj.introduceri + ' / expedieri ' + rulaj.expedieri + ' lei), sub pragul Intrastat (' + pragIntro + ' lei) — monitorizează; la depășire devii obligat.');
  } else if (profile.intrastat && !depasesteIntro && !depasesteExp) {
    add('info', 'intrastat-marcat-sub-prag',
      'Intrastat e marcat, dar rulajul intracomunitar din ' + year + ' e sub prag pe ambele fluxuri — verifică dacă mai ești obligat.');
  }

  // 5b) PARTENERII, din registrul public ANAF (art. 11 Cod fiscal si art. 297 alin. (2)).
  //     Sunt singurele constatari care se sprijina pe o informatie pe care firma NU o poate scoate
  //     din propriile documente — de aceea lipsa verificarii e ea insasi o constatare.
  for (const f of controalePartener(v, yearEntries, year)) findings.push(f);

  // 6) Regim profit cu venituri, dar fara inregistrarea impozitului pe profit pe an -> reminder D101
  if (profile.profit) {
    const areVenit = venituriClasa7(yearEntries) > 0;
    const areImpozit = yearEntries.some((e) => e.tip === 'impozit_profit' || (e.lines || []).some((l) => String(l.debit).startsWith('691')));
    if (areVenit && !areImpozit) add('info', 'profit-fara-inchidere',
      'Regim de impozit pe profit cu venituri în ' + year + ', dar impozitul pe profit nu e încă înregistrat (691=4411) — necesar pentru D101.');
  }

  const byLevel = { eroare: 0, atentie: 0, info: 0 };
  for (const f of findings) byLevel[f.nivel] += 1;
  const art310Result = tvaArt310.analyze(posted, year, { threshold: Number(rates.plafonScutireTvaLei) || 0 });
  return { year, profil: profile, findings, byLevel,
    microEligibility: microAssessment,
    tvaArt310: { threshold: art310Result.threshold, total: art310Result.total,
      complete: art310Result.complete, crossing: art310Result.crossing,
      unresolved: art310Result.unresolved, operationCount: art310Result.operations.length,
      categories: tvaArt310.clientCategories() },
    ruleSetId: ruleSet.id, fiscalRulesHash: ruleSet.hash,
    ok: findings.every((f) => f.nivel !== 'eroare') };
}

// `cifraAfaceri` / `venituriClasa7` sunt expuse pentru teste: sunt agregarile pe care le golea
// inchiderea anuala, iar prin `check()` defectul se vedea doar ca ABSENTA unei constatari — adica
// exact ca un control trecut. Testate direct, egalitatea inainte/dupa inchidere e verificabila.
module.exports = { check, cifraAfaceri, venituriClasa7, controalePartener, achizitiiPePartener };
