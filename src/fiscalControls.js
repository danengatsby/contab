'use strict';

// CONTROALE fiscale derivate din PROFIL + date: al treilea pilon (langa declaratii si alerte)
// generat din motorul de profil fiscal. Verifica coerenta datelor cu regimul declarat al firmei
// (neplatitor TVA care colecteaza TVA, micro peste plafon, plafon Intrastat, etc.) si intoarce
// o lista de constatari { nivel: eroare|atentie|info, cod, mesaj }. Pur (peste vederea scoped).

const acc = require('./accounting');
const coa = require('./chartOfAccounts');
const fiscal = require('./fiscal');
const fiscalProfile = require('./fiscalProfile');
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

function venituriClasa7(entries) {
  const r = acc.accumulate(acc.allLines(entries));
  let venit = 0;
  for (const cod of Object.keys(r)) {
    const a = coa.getAccount(cod);
    if ((a ? a.clasa : Number(String(cod)[0])) === 7) venit = round2(venit + (r[cod].c - r[cod].d));
  }
  return venit;
}

/** Ruleaza controalele de coerenta pentru firma (vedere scoped) pe anul `opts.year`. */
function check(v, opts) {
  opts = opts || {};
  const company = (v || {}).company || {};
  const profile = fiscalProfile.build(company, { angajati: (v || {}).angajati });
  const year = String(opts.year || new Date().getFullYear());
  const posted = acc.postedEntries(v);
  const yearEntries = posted.filter((e) => String(e.period || periodOf(e.data)).startsWith(year));
  const findings = [];
  const add = (nivel, cod, mesaj) => findings.push({ nivel, cod, mesaj });

  // 1) Neplatitor TVA dar COLECTEAZA TVA (4427) -> inconsistenta de regim
  if (!profile.tvaPlatitor) {
    const colecteaza = yearEntries.some((e) => (e.lines || []).some((l) => String(l.credit).startsWith('4427') && Number(l.suma) > 0));
    if (colecteaza) add('eroare', 'tva-neplatitor-colecteaza',
      'Firma nu e plătitoare de TVA, dar în ' + year + ' există TVA colectată (cont 4427). Verifică regimul TVA sau facturile emise.');
  }

  // 2) Platitor TVA fara cod CAEN — D300 il cere
  if (profile.tvaPlatitor && !company.caen) add('atentie', 'tva-fara-caen',
    'Ești plătitor de TVA, dar codul CAEN nu e completat — decontul D300 îl solicită.');

  // 3) Micro peste plafonul de venituri -> trebuie trecut la impozit pe profit
  if (profile.micro) {
    const venitAn = venituriClasa7(yearEntries);
    const plafonLei = round2((fiscal.FISCAL.plafonMicroEur || 0) * (fiscal.FISCAL.cursPlafonMicro || 0));
    if (plafonLei > 0 && venitAn > plafonLei) add('atentie', 'micro-peste-plafon',
      'Veniturile anului ' + year + ' (' + venitAn + ' lei) depășesc plafonul micro (~' + plafonLei + ' lei) — firma datorează impozit pe profit (D101), nu micro.');
    // 4) Micro fara salariat — conditia de incadrare (art. 47 Cod fiscal)
    if (!((v.angajati || []).length)) add('atentie', 'micro-fara-salariat',
      'Regim micro fără salariat înregistrat — condiția de salariat (normă întreagă) nu pare îndeplinită; fără salariat se datorează impozit pe profit.');
  }

  // 5) Intrastat AUTO-DETECT: compara rulajul intracomunitar cu pragurile INS (pe flux). Peste
  //    prag si nemarcat -> obligat (atentie); sub prag dar cu operatiuni -> monitorizeaza (info);
  //    marcat dar sub prag pe ambele fluxuri -> poate iesi din obligatie (info).
  const areIntracom = yearEntries.some((e) => INTRACOM_TYPES.has(e.tip));
  const rulaj = intracomTurnover(yearEntries);
  const pragIntro = Number(fiscal.FISCAL.pragIntrastatIntroduceri) || 0;
  const pragExp = Number(fiscal.FISCAL.pragIntrastatExpedieri) || 0;
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

  // 6) Regim profit cu venituri, dar fara inregistrarea impozitului pe profit pe an -> reminder D101
  if (profile.profit) {
    const areVenit = venituriClasa7(yearEntries) > 0;
    const areImpozit = yearEntries.some((e) => e.tip === 'impozit_profit' || (e.lines || []).some((l) => String(l.debit).startsWith('691')));
    if (areVenit && !areImpozit) add('info', 'profit-fara-inchidere',
      'Regim de impozit pe profit cu venituri în ' + year + ', dar impozitul pe profit nu e încă înregistrat (691=4411) — necesar pentru D101.');
  }

  const byLevel = { eroare: 0, atentie: 0, info: 0 };
  for (const f of findings) byLevel[f.nivel] += 1;
  return { year, profil: profile, findings, byLevel, ok: findings.every((f) => f.nivel !== 'eroare') };
}

module.exports = { check };
