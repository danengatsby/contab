'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  PLAFONUL DE 33% AL AVANTAJELOR NEIMPOZABILE (art. 76 alin. (4^1) si (4^2))
//
//  Ce rezolva: pana acum orice suma pusa in „venit neimpozabil suplimentar" iesea din baza
//  NELIMITAT. Legea are DOUA capace, si amandoua taie, in ordinea asta:
//    1. limita INDIVIDUALA a fiecarei categorii (400 EUR/an la pensii, 20% din salariul minim la
//       cazare, un tichet de masa/zi la hrana...);
//    2. plafonul COMUN de 33% din salariul de BAZA corespunzator locului de munca ocupat.
//  Ce depaseste oricare dintre ele NU e „pierdut": devine venit salarial obisnuit — impozit 10%,
//  CAS (art. 139 alin. (1) lit. v)), CASS (art. 157 alin. (1) lit. v)) si CAM. De asta rezultatul
//  se intoarce spart in `neimpozabil` / `impozabil`, nu ca un singur numar plafonat: partea
//  impozabila trebuie sa ajunga in baze, altfel plafonul ar fi doar o taiere, adica tot o eroare.
//
//  SALARIUL DE BAZA, nu brutul realizat: art. 76 alin. (4^1) spune „salariul de baza corespunzator
//  locului de munca ocupat". Un spor nu mareste plafonul, iar o luna cu concediu medical nu il
//  micsoreaza. Acelasi camp pe care il foloseste deja `fiscal.neimpozabilMinim` (`a.salariuBrut`,
//  fara spor), din acelasi motiv.
//
//  ORDINEA conteaza si e o DECIZIE, nu un detaliu: cand suma categoriilor depaseste 33%, ordinea
//  hotaraste care categorie ramane neimpozabila si care se impoziteaza. Art. 76 alin. (4^2) o
//  lasa expres angajatorului; implicita e cea din lege (lit. a -> j), fiindca o ordine inventata
//  ar muta bani intre categorii fara ca nimeni sa fi ales asta. Firma o poate rescrie prin
//  `ordine` (lista de id-uri) — vezi `ordoneaza()`.
//
//  Modulul e PUR: primeste sumele acordate, zilele si consumul anual de pana acum, si nu stie
//  nimic despre baza de date. Parametrii vin din `src/fiscalConfig.js` (BENEFICII + RATES),
//  injectati de `src/fiscal.js` — la fel ca la deducerea personala.
// ─────────────────────────────────────────────────────────────────────────────

const { round2 } = require('./util');

// `round2(undefined)` intoarce NaN, iar aici aproape toate intrarile sunt optionale (o categorie
// neacordata, un consum anual inexistent). Un NaN nu ar arunca: s-ar plimba tacut prin plafon si
// ar iesi ca „impozabil: NaN" in D112. Tot ce vine din afara trece prin `lei()`.
function lei(x) {
  const n = Number(x);
  return Number.isFinite(n) ? round2(n) : 0;
}

/** Categoriile care se consuma ANUAL (limita se epuizeaza pe an, nu pe luna). */
const TIPURI_ANUALE = new Set(['anEur', 'anLei']);

function esteAnuala(cat) {
  return TIPURI_ANUALE.has(((cat || {}).limita || {}).tip);
}

/**
 * Limita individuala a unei categorii intr-o luna, in lei.
 * Intoarce `{ limita, motiv }`; `limita === null` inseamna „fara limita proprie" (doar 33%).
 * `motiv` explica o limita ZERO — fara el, o categorie care nu se acorda pare o eroare de calcul.
 */
function limitaIndividuala(cat, ctx) {
  const lim = cat.limita || {};
  const zile = ctx.zile || {};
  const cfg = ctx.cfg || {};

  // lit. b), ultima teza: hrana si tichetele de masa nu se cumuleaza — cine primeste tichete
  // nu poate primi si contravaloarea hranei ca venit neimpozabil.
  if (cat.excludeTichete && lei(ctx.tichete) > 0) {
    return { limita: 0, motiv: 'Nu se cumulează cu tichetele de masă (art. 76 alin. (4^1) lit. b).' };
  }

  if (lim.tip === 'fara') return { limita: null, motiv: '' };

  if (lim.tip === 'zi') {
    const n = Math.max(0, Number(zile[lim.zile]) || 0);
    if (!n) return { limita: 0, motiv: 'Zero zile de ' + lim.zile + ' în lună.' };
    // telemunca: 400 lei/LUNA, proportional cu zilele — nu 400 lei pe fiecare zi
    if (lim.proportionalLunar) {
      const zl = Math.max(1, Number(zile.lucratoare) || 1);
      return { limita: lei((lim.lei * Math.min(n, zl)) / zl), motiv: '' };
    }
    return { limita: lei(lim.lei * n), motiv: '' };
  }

  if (lim.tip === 'luna') return { limita: lei(lim.lei), motiv: '' };

  if (lim.tip === 'lunaCopil') {
    const copii = Math.max(0, Math.round(Number(ctx.copii) || 0));
    if (!copii) return { limita: 0, motiv: 'Niciun copil declarat în unitate de educație timpurie.' };
    return { limita: lei(lim.lei * copii), motiv: '' };
  }

  if (lim.tip === 'pctMinim') {
    const sm = lei(ctx.salariuMinim);
    if (!(sm > 0)) return { limita: 0, motiv: 'Salariul minim nu e configurat.' };
    return { limita: lei((sm * lim.pct) / 100), motiv: '' };
  }

  // Plafoanele ANUALE: din limita anului se scade ce s-a acordat deja NEIMPOZABIL in lunile
  // trecute ale aceluiasi an. Consumul e pe partea neimpozabila, nu pe cea acordata: o suma deja
  // impozitata anul asta n-a consumat nimic din plafon.
  if (esteAnuala(cat)) {
    const anuala = lim.tip === 'anEur'
      ? lei(lim.eur * (Number(cfg.cursEur) || 0))
      : lei(lim.lei);
    const consumat = Math.max(0, lei((ctx.consumAnual || {})[cat.id]));
    const ramas = lei(Math.max(0, anuala - consumat));
    if (anuala > 0 && ramas === 0) {
      return { limita: 0, motiv: 'Plafonul anual (' + anuala + ' lei) e deja consumat.', anuala, consumat };
    }
    return { limita: ramas, motiv: '', anuala, consumat };
  }

  return { limita: 0, motiv: 'Tip de limită necunoscut: ' + lim.tip };
}

/** Categoriile in ordinea de includere in plafon: cea ceruta de firma, apoi restul (ordinea legala). */
function ordoneaza(categorii, ordine) {
  if (!Array.isArray(ordine) || !ordine.length) return categorii.slice();
  const dupaId = new Map(categorii.map((c) => [c.id, c]));
  const iesire = [];
  for (const id of ordine) {
    const c = dupaId.get(id);
    if (c && !iesire.includes(c)) iesire.push(c);
  }
  for (const c of categorii) if (!iesire.includes(c)) iesire.push(c);
  return iesire;
}

/**
 * Repartizeaza avantajele lunii intre partea neimpozabila si cea impozabila.
 *
 * @param {object} intrare
 *   - salariuBaza    salariul de baza contractual (fara spor) — baza plafonului de 33%
 *   - acordate       { <idCategorie>: lei } sumele acordate in luna
 *   - zile           { lucratoare, lucrate, mobilitate, telemunca }
 *   - copii          copii in unitati de educatie timpurie (lit. i)
 *   - tichete        valoarea tichetelor de masa (blocheaza lit. b)
 *   - consumAnual    { <idCategorie>: lei neimpozabili acordati deja in anul curent }
 *   - ordine         [idCategorie] — ordinea aleasa de angajator (art. 76 alin. (4^2))
 * @param {object} cfg { categorii, pct, cursEur }
 * @returns {{plafon:number, randuri:Array, totalAcordat:number, totalNeimpozabil:number,
 *            totalImpozabil:number, ramas:number, depasit:boolean}}
 */
function calcul(intrare, cfg) {
  const i = intrare || {};
  const c = cfg || {};
  const categorii = ordoneaza(c.categorii || [], i.ordine);
  const acordate = i.acordate || {};
  const salariuBaza = Math.max(0, lei(i.salariuBaza));
  const pct = Number(c.pct);
  const plafon = lei((salariuBaza * (Number.isFinite(pct) ? pct : 0)) / 100);

  const ctx = {
    zile: i.zile || {}, copii: i.copii, tichete: i.tichete,
    salariuMinim: i.salariuMinim, consumAnual: i.consumAnual || {},
    cfg: { cursEur: c.cursEur },
  };

  let ramas = plafon;
  const randuri = [];
  for (const cat of categorii) {
    const acordat = Math.max(0, lei(acordate[cat.id]));
    if (!acordat) continue; // categoriile neacordate nu apar pe statul de plata
    const li = limitaIndividuala(cat, ctx);

    // Pasul 1 — limita individuala. Ce trece de ea e impozabil direct, fara sa mai atinga plafonul
    // de 33%: altfel o singura categorie cu suma mare ar consuma plafonul altora.
    const dupaIndividual = li.limita === null ? acordat : Math.min(acordat, li.limita);
    const pesteIndividual = lei(acordat - dupaIndividual);

    // Pasul 2 — plafonul comun, in ordinea stabilita.
    const inPlafon = lei(Math.min(dupaIndividual, Math.max(0, ramas)));
    const pestePlafon = lei(dupaIndividual - inPlafon);
    ramas = lei(ramas - inPlafon);

    randuri.push({
      id: cat.id, lit: cat.lit, nume: cat.nume, temei: cat.temei,
      acordat,
      limitaIndividuala: li.limita, limitaAnuala: li.anuala != null ? li.anuala : null,
      consumatAnual: li.consumat != null ? li.consumat : null,
      neimpozabil: inPlafon,
      impozabil: lei(pesteIndividual + pestePlafon),
      pesteIndividual, pestePlafon,
      motiv: li.motiv || '',
    });
  }

  const total = (camp) => lei(randuri.reduce((s, r) => s + r[camp], 0));
  const totalImpozabil = total('impozabil');
  return {
    plafon, randuri,
    totalAcordat: total('acordat'),
    totalNeimpozabil: total('neimpozabil'),
    totalImpozabil,
    ramas: Math.max(0, ramas),
    depasit: totalImpozabil > 0,
  };
}

/**
 * Consumul anual de pana la `period` (exclusiv), pe categorii, dintr-un istoric de state de plata.
 * Sursa e partea NEIMPOZABILA deja acordata — vezi nota din `limitaIndividuala`.
 * Doar lunile aceluiasi AN conteaza: plafoanele de la lit. d)-g) sunt anuale, nu glisante.
 */
function consumAnual(history, angajatId, period) {
  const an = String(period || '').slice(0, 4);
  const out = {};
  if (!an) return out;
  for (const h of history || []) {
    const p = String(h.period || '');
    if (p.slice(0, 4) !== an || p >= String(period)) continue;
    const rand = (h.rows || []).find((r) => r.angajatId === angajatId);
    for (const b of (rand && rand.beneficii) || []) {
      out[b.id] = lei((out[b.id] || 0) + (Number(b.neimpozabil) || 0));
    }
  }
  return out;
}

module.exports = { calcul, consumAnual, limitaIndividuala, ordoneaza, esteAnuala };
