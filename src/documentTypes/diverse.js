'use strict';

// DIVERSE — vezi index.js pentru contractul tipurilor.

const { L, F, TROZ } = require('./helpers');
const fiscal = require('../fiscal');
const { round2 } = require('../util');

module.exports = [
  // ─────────────────────────── DIVERSE ────────────────────────────
  {
    id: 'amortizare',
    nume: 'Amortizare lunara mijloace fixe',
    grup: 'Diverse',
    fields: [F.data, F.suma,
      { name: 'contAmort', label: 'Cont amortizare', type: 'account', default: '281' }],
    build: (d) => [L('6811', d.contAmort || '281', d.suma, 'Amortizare lunara')],
  },
  {
    id: 'factura_storno_vanzare',
    nume: 'Factura storno/corectie emisa (in rosu)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'refFactura', label: 'Factura stornata (referinta)', type: 'text' },
      F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('4111', '707', -d.baza, 'Storno venit (in rosu)')];
      if (d.tva > 0) lines.push(L('4111', '4427', -d.tva, 'Storno TVA colectata'));
      return lines;
    },
  },
  {
    id: 'factura_storno_cumparare',
    nume: 'Factura storno/corectie primita (in rosu)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota,
      { name: 'contStoc', label: 'Cont stornat (stoc/cheltuiala)', type: 'account', default: '371' }],
    build: (d) => {
      const lines = [L(d.contStoc || '371', '401', -d.baza, 'Storno achizitie (in rosu)')];
      if (d.tva > 0) lines.push(L('4426', '401', -d.tva, 'Storno TVA deductibila'));
      return lines;
    },
  },
  {
    id: 'bon_consum',
    nume: 'Bon de consum (iesire materiale din stoc)',
    grup: 'Stocuri',
    fields: [F.data, F.document, F.suma,
      { name: 'contChelt', label: 'Cont cheltuiala', type: 'account', default: '601' },
      { name: 'contStoc', label: 'Cont stoc', type: 'account', default: '301' }],
    build: (d) => [L(d.contChelt || '601', d.contStoc || '301', d.suma, 'Consum din stoc (bon de consum)')],
  },
  {
    id: 'acordare_avans',
    nume: 'Acordare avans de trezorerie (catre angajat)',
    grup: 'Trezorerie',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Acordat din', type: 'select', options: TROZ, default: '5311' }],
    build: (d) => [L('542', d.cont || '5311', d.suma, 'Avans de trezorerie acordat')],
  },
  {
    id: 'decont_deplasare',
    nume: 'Decont cheltuieli deplasare/delegatie',
    grup: 'Diverse',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'contChelt', label: 'Cont cheltuiala', type: 'account', default: '625' },
      { name: 'cont', label: 'Acoperit din', type: 'select',
        options: [{ value: '542', label: '542 Avans de trezorerie' }, { value: '5311', label: '5311 Casa' }, { value: '5121', label: '5121 Banca' }], default: '542' }],
    build: (d) => [L(d.contChelt || '625', d.cont || '542', d.suma, 'Decont cheltuieli deplasare')],
  },
  {
    id: 'dobanda_bancara',
    nume: 'Dobanda bancara (extras)',
    grup: 'Trezorerie',
    fields: [F.data, F.document, F.suma, F.analiticBanca],
    build: (d) => [L('666', '5121', d.suma, 'Cheltuieli privind dobanzile')],
  },
  {
    id: 'import_vamal',
    nume: 'Import bunuri din afara UE (DVI)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document,
      { name: 'valoareBunuri', label: 'Valoarea in vama a bunurilor (lei)', type: 'number', required: true },
      { name: 'taxeVamale', label: 'Taxe vamale (lei)', type: 'number', default: 0 },
      { name: 'cota', label: 'Cota TVA in vama (%)', type: 'number', default: fiscal.FISCAL.tvaStandard },
      { name: 'contBun', label: 'Cont bunuri (stoc/imobilizare)', type: 'account', default: '371' }],
    build: (d) => {
      const baza = round2(d.valoareBunuri + (d.taxeVamale || 0));
      const tva = round2((baza * (Number(d.cota) || fiscal.FISCAL.tvaStandard)) / 100);
      const lines = [L(d.contBun || '371', '401', d.valoareBunuri, 'Import - valoarea bunurilor')];
      if (d.taxeVamale > 0) lines.push(L(d.contBun || '371', '446', d.taxeVamale, 'Taxe vamale (in costul bunurilor)'));
      lines.push(L('4426', '446', tva, 'TVA in vama (deductibila)'));
      return lines;
    },
  },
  {
    id: 'diferente_inventar',
    nume: 'Diferente la inventariere (plus / minus)',
    grup: 'Stocuri',
    fields: [F.data, F.document, F.suma,
      { name: 'sens', label: 'Tip diferenta', type: 'select',
        options: [{ value: 'minus', label: 'Minus / lipsa la inventar' }, { value: 'plus', label: 'Plus la inventar' }], default: 'minus' },
      { name: 'contStoc', label: 'Cont stoc', type: 'account', default: '371' },
      { name: 'contChelt', label: 'Cont cheltuiala (clasa 6)', type: 'account', default: '607' }],
    build: (d) => {
      if (d.sens === 'plus') return [L(d.contStoc || '371', d.contChelt || '607', d.suma, 'Plus la inventar (diminuare cheltuieli)')];
      return [L(d.contChelt || '607', d.contStoc || '371', d.suma, 'Minus / lipsa la inventar')];
    },
  },
  {
    id: 'imputare_lipsa',
    nume: 'Imputare lipsa la inventar (catre gestionar)',
    grup: 'Stocuri',
    fields: [F.data, F.partener, F.document,
      { name: 'valoareImputata', label: 'Valoare imputata (fara TVA)', type: 'number', required: true },
      { name: 'cota', label: 'Cota TVA (%)', type: 'number', default: fiscal.FISCAL.tvaStandard },
      { name: 'contCreanta', label: 'Cont creanta', type: 'select',
        options: [{ value: '4282', label: '4282 Alte creante personal' }, { value: '461', label: '461 Debitori diversi' }], default: '4282' }],
    build: (d) => {
      const tva = round2((d.valoareImputata * (Number(d.cota) || fiscal.FISCAL.tvaStandard)) / 100);
      const o = [L(d.contCreanta || '4282', '7588', d.valoareImputata, 'Imputare lipsa la inventar - venit')];
      if (tva > 0) o.push(L(d.contCreanta || '4282', '4427', tva, 'TVA aferenta imputarii'));
      return o;
    },
  },
  {
    id: 'plata_taxe',
    nume: 'Plata taxe/impozite/TVA catre buget (sau vama)',
    grup: 'Trezorerie',
    fields: [F.data, F.document, F.suma,
      { name: 'contTaxa', label: 'Cont datorie (446, 4423, 444, 436, 4411...)', type: 'account', default: '446' },
      { name: 'cont', label: 'Platita din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.contTaxa || '446', d.cont || '5121', d.suma, 'Plata taxe/impozite catre buget')],
  },
  {
    id: 'casare_mijloc_fix',
    nume: 'Casare / scoatere din uz mijloc fix',
    grup: 'Diverse',
    fields: [F.data, F.document,
      { name: 'contImob', label: 'Cont imobilizare', type: 'account', default: '2131' },
      { name: 'valoare', label: 'Valoare de intrare', type: 'number', required: true },
      { name: 'amortizare', label: 'Amortizare cumulata', type: 'number', default: 0 },
      { name: 'contAmort', label: 'Cont amortizare', type: 'account', default: '281' }],
    build: (d) => {
      const ramas = round2(d.valoare - (d.amortizare || 0));
      const lines = [];
      if (d.amortizare > 0) lines.push(L(d.contAmort || '281', d.contImob || '2131', d.amortizare, 'Scaderea amortizarii cumulate'));
      if (ramas > 0) lines.push(L('6583', d.contImob || '2131', ramas, 'Valoarea ramasa neamortizata'));
      return lines;
    },
  },
  {
    id: 'avans_incasat_client',
    nume: 'Avans incasat de la client (419, fara factura de avans)',
    grup: 'Trezorerie',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasat in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '419', d.suma, 'Avans incasat de la client (fara factura de avans)')],
  },
  {
    id: 'avans_platit_furnizor',
    nume: 'Avans platit catre furnizor (409, fara factura de avans)',
    grup: 'Trezorerie',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L('409', d.cont || '5121', d.suma, 'Avans platit catre furnizor (fara factura de avans)')],
  },

];
