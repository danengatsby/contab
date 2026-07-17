'use strict';

// CONSTRUCTII + HORECA + INTRACOMUNITAR/VALUTA + TRANSPORT — vezi index.js pentru contractul tipurilor.

const { L, F, TROZ } = require('./helpers');
const fiscal = require('../fiscal');
const { round2 } = require('../util');

module.exports = [
  // ─────────────────── CONSTRUCTII ───────────────────
  {
    id: 'lucrari_in_curs',
    nume: 'Lucrari/servicii in curs de executie (332)',
    grup: 'Constructii',
    fields: [F.data, F.document, F.suma,
      { name: 'sens', label: 'Operatiune', type: 'select',
        options: [{ value: 'inreg', label: 'Inregistrare lucrari in curs (332=712)' }, { value: 'reluare', label: 'Reluare la facturare (712=332)' }], default: 'inreg' }],
    build: (d) => d.sens === 'reluare'
      ? [L('712', '332', d.suma, 'Reluarea lucrarilor in curs la facturare')]
      : [L('332', '712', d.suma, 'Lucrari in curs de executie')],
  },
  {
    id: 'garantie_retinuta',
    nume: 'Garantie de buna executie retinuta de beneficiar (2678)',
    grup: 'Constructii',
    fields: [F.data, F.partener, F.document, F.suma],
    build: (d) => [L('2678', '4111', d.suma, 'Garantie de buna executie retinuta')],
  },
  {
    id: 'garantie_restituita',
    nume: 'Restituire garantie de buna executie',
    grup: 'Constructii',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasata in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '2678', d.suma, 'Restituire garantie de buna executie')],
  },
  // ─────────────────── HoReCa (pret de vanzare cu amanuntul) ───────────────────
  {
    id: 'horeca_intrare',
    nume: 'HoReCa: intrare marfa la pret de vanzare (371/378/4428)',
    grup: 'HoReCa',
    fields: [F.data, F.partener, F.document,
      { name: 'cost', label: 'Cost achizitie (fara TVA)', type: 'number', required: true },
      { name: 'tvaDed', label: 'TVA deductibila la achizitie', type: 'number', default: 0 },
      { name: 'adaos', label: 'Adaos comercial', type: 'number', default: 0 },
      { name: 'cotaVanzare', label: 'Cota TVA la vanzare (%)', type: 'number', default: fiscal.FISCAL.tvaRedus }],
    build: (d) => {
      const lines = [L('371', '401', d.cost, 'Intrare marfa la cost')];
      if (d.tvaDed > 0) lines.push(L('4426', '401', d.tvaDed, 'TVA deductibila'));
      if (d.adaos > 0) lines.push(L('371', '378', d.adaos, 'Adaos comercial'));
      const tvaNeexig = round2(((d.cost + d.adaos) * Number(d.cotaVanzare || fiscal.FISCAL.tvaRedus)) / 100);
      if (tvaNeexig > 0) lines.push(L('371', '4428', tvaNeexig, 'TVA neexigibila (pret de vanzare)'));
      return lines;
    },
  },
  {
    id: 'horeca_vanzare',
    nume: 'HoReCa: vanzare amanunt + descarcare gestiune',
    grup: 'HoReCa',
    fields: [F.data, F.document,
      { name: 'numerar', label: 'Incasare numerar (cu TVA)', type: 'number', default: 0 },
      { name: 'card', label: 'Incasare card (cu TVA)', type: 'number', default: 0 },
      { name: 'cota', label: 'Cota TVA (%)', type: 'number', default: fiscal.FISCAL.tvaRedus },
      { name: 'cost', label: 'Cost marfa vanduta', type: 'number', default: 0 },
      { name: 'adaos', label: 'Adaos aferent vanzarii', type: 'number', default: 0 }],
    build: (d) => {
      // Incasarea e bruta (cu TVA): venitul 707 primeste doar BAZA, TVA colectata merge pe 4427,
      // iar descarcarea de gestiune scoate din 371 si TVA neexigibila aferenta (4428 = 371) —
      // 371 e tinut la pret de vanzare cu amanuntul (cost + adaos + TVA neexigibila).
      const lines = [];
      const cota = Number(d.cota || fiscal.FISCAL.tvaRedus);
      const tvaDin = (brut) => round2((brut * cota) / (100 + cota));
      if (d.numerar > 0) {
        const tvaN = tvaDin(d.numerar);
        lines.push(L('5311', '707', round2(d.numerar - tvaN), 'Incasare numerar - venit (baza)'));
        if (tvaN > 0) lines.push(L('5311', '4427', tvaN, 'TVA colectata (numerar)'));
      }
      if (d.card > 0) {
        const tvaC = tvaDin(d.card);
        lines.push(L('5121', '707', round2(d.card - tvaC), 'Incasare card - venit (baza)'));
        if (tvaC > 0) lines.push(L('5121', '4427', tvaC, 'TVA colectata (card)'));
      }
      if (d.cost > 0) lines.push(L('607', '371', d.cost, 'Descarcare gestiune - cost'));
      if (d.adaos > 0) lines.push(L('378', '371', d.adaos, 'Descarcare gestiune - adaos'));
      const tvaNeexig = round2(((Number(d.cost) || 0) + (Number(d.adaos) || 0)) * cota / 100);
      if (tvaNeexig > 0) lines.push(L('4428', '371', tvaNeexig, 'Descarcare gestiune - TVA neexigibila aferenta'));
      return lines;
    },
  },
  // ─────────────────── COMERT INTRACOMUNITAR / VALUTA ───────────────────
  {
    id: 'diferenta_curs',
    nume: 'Diferenta de curs valutar (favorabila / nefavorabila)',
    grup: 'Cumparari',
    fields: [F.data, F.document, F.suma,
      { name: 'sens', label: 'Tip diferenta', type: 'select',
        options: [{ value: 'favorabila', label: 'Favorabila (venit 765)' }, { value: 'nefavorabila', label: 'Nefavorabila (cheltuiala 665)' }], default: 'favorabila' },
      { name: 'contTert', label: 'Cont trezorerie/tert', type: 'account', default: '5124' }],
    build: (d) => d.sens === 'nefavorabila'
      ? [L('665', d.contTert || '401', d.suma, 'Diferenta de curs nefavorabila')]
      : [L(d.contTert || '5124', '765', d.suma, 'Diferenta de curs favorabila')],
  },
  {
    id: 'incasare_numerar_valuta',
    nume: 'Incasare numerar in valuta (casa 5314)',
    grup: 'Trezorerie',
    fields: [F.data, F.document,
      { name: 'moneda', label: 'Moneda (EUR, USD...)', type: 'text', default: 'EUR', required: true },
      { name: 'sumaValuta', label: 'Suma in valuta', type: 'number', required: true },
      { name: 'curs', label: 'Curs valutar (lei/valuta)', type: 'number', required: true },
      { name: 'contraparte', label: 'Provine din contul', type: 'select',
        options: [{ value: '4111', label: '4111 Clienti' }, { value: '461', label: '461 Debitori diversi' }, { value: '5124', label: '5124 Banca in valuta' }, { value: '455', label: '455 Asociati / actionari' }], default: '4111' },
      F.explicatie],
    build: (d) => [L('5314', d.contraparte || '4111', round2((Number(d.sumaValuta) || 0) * (Number(d.curs) || 0)), 'Incasare numerar in valuta ' + (d.moneda || ''))],
  },
  {
    id: 'plata_numerar_valuta',
    nume: 'Plata numerar in valuta (casa 5314)',
    grup: 'Trezorerie',
    fields: [F.data, F.document,
      { name: 'moneda', label: 'Moneda (EUR, USD...)', type: 'text', default: 'EUR', required: true },
      { name: 'sumaValuta', label: 'Suma in valuta', type: 'number', required: true },
      { name: 'curs', label: 'Curs valutar (lei/valuta)', type: 'number', required: true },
      { name: 'contraparte', label: 'Se plateste catre contul', type: 'select',
        options: [{ value: '401', label: '401 Furnizori' }, { value: '462', label: '462 Creditori diversi' }, { value: '542', label: '542 Avansuri de trezorerie' }, { value: '455', label: '455 Asociati / actionari' }], default: '401' },
      F.explicatie],
    build: (d) => [L(d.contraparte || '401', '5314', round2((Number(d.sumaValuta) || 0) * (Number(d.curs) || 0)), 'Plata numerar in valuta ' + (d.moneda || ''))],
  },
  // ─────────────────── TRANSPORT ───────────────────
  {
    id: 'combustibil_50',
    nume: 'Combustibil cu TVA deductibila 50% (vehicul limitat)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.cota],
    build: (d) => {
      const tvaTotal = round2((d.baza * Number(d.cota || fiscal.FISCAL.tvaStandard)) / 100);
      const tvaDed = round2(tvaTotal * fiscal.FISCAL.deductibilitateTvaAutoLimitat / 100);
      const tvaNed = round2(tvaTotal - tvaDed);
      const lines = [L('6022', '401', d.baza, 'Cheltuieli combustibili')];
      if (tvaDed > 0) lines.push(L('4426', '401', tvaDed, 'TVA deductibila 50%'));
      if (tvaNed > 0) lines.push(L('6022', '401', tvaNed, 'TVA nedeductibila 50% (in cheltuiala)'));
      return lines;
    },
  },
  {
    id: 'taxe_drum',
    nume: 'Rovinieta / taxe de drum (635)',
    grup: 'Diverse',
    fields: [F.data, F.document, F.suma],
    build: (d) => [L('635', '446', d.suma, 'Rovinieta / taxe de drum')],
  },
  {
    id: 'nota_contabila',
    nume: 'Nota contabila libera (debit = credit)',
    grup: 'Diverse',
    fields: [F.data, F.explicatie,
      { name: 'debit', label: 'Cont debitor', type: 'account', required: true },
      { name: 'credit', label: 'Cont creditor', type: 'account', required: true },
      F.suma],
    build: (d) => [L(d.debit, d.credit, d.suma, d.explicatie || 'Nota contabila')],
  },

];
