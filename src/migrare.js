'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  PRELUAREA UNEI FIRME DIN ALT PROGRAM DE CONTABILITATE
//
//  Obiectia numarul unu la schimbarea furnizorului nu e pretul si nu sunt functiile: e ca nimeni
//  nu retasteaza soldurile a 40 de clienti. Fluxul de aici citeste balanta de verificare exportata
//  din programul vechi (CSV/XLS/XLSX), o mapeaza pe planul de conturi si o transforma in solduri
//  de preluare — cu PREVIZUALIZARE si raport de erori INAINTE de orice scriere.
//
//  REGULA DE AUR: balanta trebuie sa iasa ECHILIBRATA (total debit == total credit). Daca nu iese,
//  importul se refuza INTREG. O preluare pe jumatate e mai rea decat niciuna: contabilul crede ca
//  are datele, iar dezechilibrul apare abia peste luni, in balanta lui.
//
//  Ambiguitatea separatorului („1.234" = o mie doua sute treizeci si patru SAU 1,234?) nu se
//  ghiceste: se deduce din convenția intregului fisier, iar cand fisierul nu lamureste, se
//  raporteaza ca ambiguitate si raspunde omul. Un ghicit tacit costa un factor de 1000 exact pe
//  soldurile de deschidere, care se propaga apoi in toata contabilitatea.
//
//  ATENTIE (datorie tehnica asumata): aceeasi deductie de separator exista si in `public/plan.js`,
//  pentru editorul de solduri din interfata. Nu se poate partaja cod intre `src/` si `public/`
//  (unul e CommonJS pe server, celalalt modul ES in browser), deci exista un test care compara
//  CELE DOUA implementari pe acelasi corpus de tokenuri. Daca driftează, suita pica.
// ─────────────────────────────────────────────────────────────────────────────

const { round2 } = require('./util');
const coa = require('./chartOfAccounts');

// ── Deductia conventiei separatorilor (identica cu public/plan.js) ──────────
const AMOUNT_RE = /^-?\d+(?:[.,]\d+)*$/;
const clean = (raw) => String(raw == null ? '' : raw).trim().replace(/\s/g, '').replace(/lei|ron/gi, '');

function splitAmount(s) {
  if (!AMOUNT_RE.test(s)) return null;
  const neg = s.startsWith('-'); const body = neg ? s.slice(1) : s;
  return { sign: neg ? -1 : 1, body, dots: (body.match(/\./g) || []).length, commas: (body.match(/,/g) || []).length };
}

/** Rolul separatorilor dedus dintr-UN SINGUR token, doar cand tokenul nu lasa loc de interpretare. */
function tokenRoles(raw) {
  const s = clean(raw); if (!s) return {};
  const p = splitAmount(s); if (!p) return {};
  const { body, dots, commas } = p;
  if (dots && commas) {
    return body.lastIndexOf(',') > body.lastIndexOf('.') ? { ',': 'zecimale', '.': 'mii' } : { '.': 'zecimale', ',': 'mii' };
  }
  const ch = dots ? '.' : (commas ? ',' : null);
  if (!ch) return {};
  if ((dots || commas) > 1) return { [ch]: 'mii' };
  const [intPart, frac] = body.split(ch);
  if (frac.length !== 3) return { [ch]: 'zecimale' };
  if (intPart === '0' || intPart.length > 3) return { [ch]: 'zecimale' };
  return {}; // 1-3 cifre urmate de exact 3 -> ambiguu
}

/** Conventia intregului fisier: dovezile contradictorii pe acelasi separator ANULEAZA deductia. */
function sepConvention(tokens) {
  const roles = {};
  for (const t of tokens || []) {
    const r = tokenRoles(t);
    for (const ch of Object.keys(r)) {
      if (roles[ch] === undefined) roles[ch] = r[ch];
      else if (roles[ch] !== r[ch]) roles[ch] = null;
    }
  }
  return { '.': roles['.'] || null, ',': roles[','] || null };
}

/**
 * { value, ambiguous }. `roles` fixeaza rolul separatorilor (dedus din fisier sau ales de om).
 * Structura urmareste FIDEL `public/plan.js` — inclusiv faptul ca la ambiguitate se intoarce
 * totusi o valoare provizorie (citirea zecimala), ca interfata sa poata afisa ceva. Divergenta
 * dintre cele doua implementari e prinsa de poarta din test/frontend.mjs.
 */
function parseAmount(raw, roles) {
  const s = clean(raw);
  if (!s) return { value: 0, ambiguous: false };
  const p = splitAmount(s);
  if (!p) return { value: 0, ambiguous: false };
  const { sign, body, dots, commas } = p;
  const num2 = (t) => { const n = Number(t); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
  if (!dots && !commas) return { value: sign * num2(body), ambiguous: false };
  if (dots && commas) {
    const dec = body.lastIndexOf(',') > body.lastIndexOf('.') ? ',' : '.';
    return { value: sign * num2(body.replace(dec === ',' ? /\./g : /,/g, '').replace(dec, '.')), ambiguous: false };
  }
  const ch = dots ? '.' : ',';
  const asMii = () => sign * num2(body.split(ch).join(''));
  const asZec = () => sign * num2(body.replace(ch, '.'));
  if ((dots || commas) > 1) return { value: asMii(), ambiguous: false };
  const [intPart, frac] = body.split(ch);
  if (frac.length !== 3 || intPart === '0' || intPart.length > 3) return { value: asZec(), ambiguous: false };
  const role = roles && roles[ch];
  if (role === 'mii') return { value: asMii(), ambiguous: false };
  if (role === 'zecimale') return { value: asZec(), ambiguous: false };
  return { value: asZec(), ambiguous: true };
}

// ── Maparea coloanelor ──────────────────────────────────────────────────────
// Fiecare camp semantic, cu tiparele de denumire intalnite in exporturile romanesti. Ordinea
// conteaza: primul tipar care se potriveste castiga coloana.
const CAMPURI = [
  { cheie: 'cont', eticheta: 'Cont', obligatoriu: true, tipare: [/^cont$/i, /simbol/i, /^cod.*cont/i, /^cont.*sintetic/i, /^symbol$/i] },
  { cheie: 'denumire', eticheta: 'Denumire cont', tipare: [/denumire/i, /^nume/i, /explicat/i, /^descriere/i] },
  { cheie: 'sid', eticheta: 'Sold initial debitor', tipare: [/sold.*ini.*deb/i, /^si.?d$/i, /^sid$/i, /initial.*debit/i, /deschidere.*debit/i] },
  { cheie: 'sic', eticheta: 'Sold initial creditor', tipare: [/sold.*ini.*cred/i, /^si.?c$/i, /^sic$/i, /initial.*credit/i, /deschidere.*credit/i] },
  { cheie: 'sfd', eticheta: 'Sold final debitor', tipare: [/sold.*fin.*deb/i, /^sf.?d$/i, /^sfd$/i, /final.*debit/i, /^debit$/i, /^rulaj.*debit/i] },
  { cheie: 'sfc', eticheta: 'Sold final creditor', tipare: [/sold.*fin.*cred/i, /^sf.?c$/i, /^sfc$/i, /final.*credit/i, /^credit$/i, /^rulaj.*credit/i] },
];

/** Deduce maparea coloanelor din antet. Intoarce { cheie: index } + coloanele nefolosite. */
function detectMapping(antet) {
  const heads = (antet || []).map((h) => String(h == null ? '' : h).trim());
  const map = {};
  const luate = new Set();
  for (const c of CAMPURI) {
    for (const tip of c.tipare) {
      const i = heads.findIndex((h, idx) => !luate.has(idx) && tip.test(h));
      if (i >= 0) { map[c.cheie] = i; luate.add(i); break; }
    }
  }
  return { map, antet: heads, nefolosite: heads.map((h, i) => (luate.has(i) ? null : { i, h })).filter(Boolean) };
}

/**
 * Construieste previzualizarea preluarii din randurile fisierului.
 * `sursa` = 'final' (implicit: soldurile finale devin solduri de preluare) sau 'initial'.
 * NU scrie nimic — doar spune ce s-ar scrie si ce nu e in regula.
 */
function buildPreview(randuri, mapping, opts) {
  opts = opts || {};
  const sursa = opts.sursa === 'initial' ? 'initial' : 'final';
  const colD = sursa === 'initial' ? mapping.sid : mapping.sfd;
  const colC = sursa === 'initial' ? mapping.sic : mapping.sfc;
  const probleme = [];
  if (mapping.cont == null) probleme.push('Nu am identificat coloana cu simbolul contului.');
  if (colD == null && colC == null) probleme.push('Nu am identificat coloanele de sold (debitor/creditor).');
  if (probleme.length) return { conturi: [], probleme, echilibrata: false, totalD: 0, totalC: 0, ambigue: 0 };

  // Conventia separatorului se deduce din TOATE sumele fisierului, nu rand cu rand.
  const tokens = [];
  for (const r of randuri) { for (const c of [colD, colC]) if (c != null && r[c] != null) tokens.push(r[c]); }
  const roles = opts.roles || sepConvention(tokens);

  const conturi = []; let ambigue = 0;
  for (let i = 0; i < randuri.length; i++) {
    const r = randuri[i];
    const cont = String(r[mapping.cont] == null ? '' : r[mapping.cont]).trim().replace(/\s/g, '');
    if (!cont || !/^\d/.test(cont)) continue;               // randuri de titlu/total: se sar tacit
    const pd = colD != null ? parseAmount(r[colD], roles) : { value: 0, ambiguous: false };
    const pc = colC != null ? parseAmount(r[colC], roles) : { value: 0, ambiguous: false };
    if (pd.ambiguous || pc.ambiguous) ambigue += 1;
    const d = round2(Math.abs(pd.value)); const c = round2(Math.abs(pc.value));
    if (d === 0 && c === 0) continue;                        // conturi soldate: nu se preiau
    const cunoscut = !!coa.getAccount(cont);
    conturi.push({
      rand: i + 1, cont, denumire: mapping.denumire != null ? String(r[mapping.denumire] || '').trim() : '',
      d, c, cunoscut,
      ambiguu: pd.ambiguous || pc.ambiguous,
    });
  }

  const totalD = round2(conturi.reduce((s, x) => s + x.d, 0));
  const totalC = round2(conturi.reduce((s, x) => s + x.c, 0));
  const diferenta = round2(totalD - totalC);
  const echilibrata = Math.abs(diferenta) < 0.005;

  if (!conturi.length) probleme.push('Niciun cont cu sold in fisier (verifica maparea coloanelor).');
  if (ambigue) {
    probleme.push(ambigue + ' sume au separator AMBIGUU („1.234" poate fi 1234 sau 1,234). '
      + 'Alege explicit rolul separatorului si reincarca previzualizarea.');
  }
  if (conturi.length && !echilibrata) {
    probleme.push('Balanta NU e echilibrata: debit ' + totalD + ' vs credit ' + totalC
      + ' (diferenta ' + diferenta + '). Importul se refuza integral.');
  }
  const necunoscute = conturi.filter((x) => !x.cunoscut);
  return {
    conturi, probleme, echilibrata, totalD, totalC, diferenta, ambigue,
    // Conturile din afara planului nu sunt o eroare (analitice proprii), dar trebuie VAZUTE.
    necunoscute: necunoscute.map((x) => x.cont),
    sePoateImporta: probleme.length === 0,
  };
}

/** Transforma previzualizarea in forma de stocare a soldurilor de preluare: { cont: {d, c} }. */
function toOpeningBalances(preview) {
  const out = {};
  for (const x of preview.conturi || []) out[x.cont] = { d: x.d, c: x.c };
  return out;
}

module.exports = { detectMapping, buildPreview, toOpeningBalances, parseAmount, sepConvention, tokenRoles, CAMPURI };
