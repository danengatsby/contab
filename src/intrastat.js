'use strict';

// Sursa unica pentru perimetrul Intrastat. Calendarul fiscal si raportul trebuie sa vada exact
// aceleasi miscari de BUNURI; altfel registrul poate cere o declaratie pe care exportul o lasa
// goala. Tipurile D301 1-3 si autofactura intracomunitara documenteaza tot introduceri fizice,
// chiar daca au alta monografie contabila fata de factura intracomunitara obisnuita.

const fiscal = require('./fiscal');
const fiscalCfg = require('./fiscalConfig');
const { round2 } = require('./util');

const TIP_D301 = 'achizitie_tva_speciala_d301';
const INCOTERMS_2020 = new Set(['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP']);

/** @returns {'introducere'|'expediere'|null} */
function flux(e) {
  if (!e) return null;
  if (e.tip === 'livrare_intracomunitara') return 'expediere';
  if (e.tip === 'achizitie_intracomunitara') return 'introducere';
  if (e.tip === 'autofactura_achizitie' && e.naturaAutofactura === 'intracom') return 'introducere';
  if (e.tip === TIP_D301 && [1, 2, 3].includes(Number(e.d301 && e.d301.tipOperatie))) return 'introducere';
  return null;
}

function codPartener(e) {
  return String((e && e.partenerCui) || '').replace(/[\s-]/g, '').toUpperCase();
}

function tara(e) { return codPartener(e).slice(0, 2); }

/** Valoarea facturata, fara TVA/taxe, in lei. */
function valoare(e, sens) {
  if (!e) return 0;
  if (e.tip === TIP_D301 && e.d301) return round2(Number(e.d301.baza) || 0);
  let total = 0;
  for (const l of e.lines || []) {
    if (sens === 'expediere' && /^70/.test(String(l.credit))) total = round2(total + (Number(l.suma) || 0));
    // Autofactura sta pe 408 pana vine factura. Limitarea la 401 ii transforma valoarea in zero.
    if (sens === 'introducere' && (String(l.credit) === '401' || String(l.credit) === '408')) {
      total = round2(total + (Number(l.suma) || 0));
    }
  }
  return total;
}

function prag(sens, date) {
  const rates = fiscal.rulesAt(date).rates;
  return Number(sens === 'introducere'
    ? rates.pragIntrastatIntroduceri
    : rates.pragIntrastatExpedieri) || 0;
}

function taraIntrastatValida(cod) {
  return cod !== 'RO' && fiscalCfg.TARI_UE_BUNURI.includes(cod);
}

function conditieValida(cod) { return INCOTERMS_2020.has(String(cod || '').toUpperCase()); }

module.exports = { TIP_D301, INCOTERMS_2020, flux, codPartener, tara, valoare, prag,
  taraIntrastatValida, conditieValida };
