'use strict';

// DIVERSE — vezi index.js pentru contractul tipurilor.

const { L, F, TROZ, rate } = require('./helpers');
const { round2 } = require('../util');

module.exports = [
  // ─────────────────────────── DIVERSE ────────────────────────────
  {
    id: 'amortizare',
    nume: 'Amortizare lunara mijloace fixe',
    grup: 'Diverse',
    fields: [F.data, F.suma,
      { name: 'contAmort', label: 'Cont amortizare', type: 'account', default: '281' }],
    build: (d) => [L('6811', d.contAmort || '281', d.suma, 'Amortizare lunară')],
  },
  {
    id: 'factura_storno_vanzare',
    nume: 'Factura storno/corectie emisa (in rosu)',
    grup: 'Vanzari',
    // nota de credit pe o factura pe care noi am emis-o
    eFactura: 'da',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'refFactura', label: 'Factura stornata (referinta)', type: 'text' },
      F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('4111', '707', -d.baza, 'Storno venit (în roșu)')];
      if (d.tva > 0) lines.push(L('4111', '4427', -d.tva, 'Storno TVA colectată'));
      return lines;
    },
  },
  {
    id: 'factura_storno_cumparare',
    nume: 'Factura storno/corectie primita (in rosu)',
    grup: 'Cumparari',
    // nota de credit PRIMITA de la furnizor — nu o emitem noi
    eFactura: 'nu',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota,
      { name: 'contStoc', label: 'Cont stornat (stoc/cheltuiala)', type: 'account', default: '371' }],
    build: (d) => {
      const lines = [L(d.contStoc || '371', '401', -d.baza, 'Storno achiziție (în roșu)')];
      if (d.tva > 0) lines.push(L('4426', '401', -d.tva, 'Storno TVA deductibilă'));
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
    fields: [F.data, F.document, F.suma,
      { name: 'cont', label: 'Cont bancar', type: 'select', options: [...TROZ, { value: '5124', label: '5124 Banca în valută' }], default: '5121' }, F.analiticBanca],
    build: (d) => [L('666', d.cont || '5121', d.suma, 'Cheltuieli privind dobânzile')],
  },
  {
    id: 'import_vamal',
    nume: 'Import bunuri din afara UE (DVI)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document,
      { name: 'valoareBunuri', label: 'Valoarea in vama a bunurilor (lei)', type: 'number', required: true },
      { name: 'taxeVamale', label: 'Taxe vamale (lei)', type: 'number', default: 0 },
      { name: 'cota', label: 'Cota TVA in vama (%)', type: 'number', default: 0, fiscalRate: 'tvaStandard' },
      { name: 'contBun', label: 'Cont bunuri (stoc/imobilizare)', type: 'account', default: '371' }, F.proRataMixt],
    build: (d) => {
      const baza = round2(d.valoareBunuri + (d.taxeVamale || 0));
      const tva = round2((baza * (Number(d.cota) || rate(d, 'tvaStandard'))) / 100);
      const lines = [L(d.contBun || '371', '401', d.valoareBunuri, 'Import - valoarea bunurilor')];
      if (d.taxeVamale > 0) lines.push(L(d.contBun || '371', '446', d.taxeVamale, 'Taxe vamale (în costul bunurilor)'));
      lines.push(L('4426', '446', tva, 'TVA în vamă (deductibilă)'));
      return lines;
    },
  },
  {
    id: 'diferente_inventar',
    nume: 'Diferente la inventariere (plus / minus)',
    grup: 'Stocuri',
    // Contul de cheltuiala ramane ALES de contabil (implicit 607, ca pana acum), dar eticheta spune
    // acum si cand se cuvine altul: minusul NEIMPUTABIL nu e cost al vanzarilor, ci alta cheltuiala
    // de exploatare (6588) — amestecat in 607, umfla costul marfii vandute si strica marja.
    //
    // Bifa `neimputabila` NU schimba monografia, ci consecinta FISCALA: art. 25(4)(c) face
    // nedeductibila cheltuiala cu stocurile lipsa din gestiune neimputabile si neasigurate. Nu se
    // poate deduce din conturi (aceeasi cheltuiala pe acelasi cont poate fi imputabila sau nu),
    // deci se marcheaza pe articol — acelasi tipar ca `auto50`, care poarta la fel o incadrare pe
    // care contabilitatea singura n-o poate decide. Vezi `reporting.cheltuieliLipsaNeimputabila`.
    fields: [F.data, F.document, F.suma,
      { name: 'sens', label: 'Tip diferenta', type: 'select',
        options: [{ value: 'minus', label: 'Minus / lipsa la inventar' }, { value: 'plus', label: 'Plus la inventar' }], default: 'minus' },
      { name: 'contStoc', label: 'Cont stoc', type: 'account', default: '371' },
      { name: 'contChelt', label: 'Cont cheltuiala (clasa 6) — la minus neimputabil foloseste 6588, nu contul de descarcare', type: 'account', default: '607' },
      { name: 'lipsaNeimputabila', label: 'Lipsa NEIMPUTABILA si neasigurata — cheltuiala e nedeductibila la impozitul pe profit (art. 25(4)(c))', type: 'checkbox' }],
    build: (d) => {
      if (d.sens === 'plus') return [L(d.contStoc || '371', d.contChelt || '607', d.suma, 'Plus la inventar (diminuare cheltuieli)')];
      return [L(d.contChelt || '607', d.contStoc || '371', d.suma,
        'Minus / lipsă la inventar' + (d.lipsaNeimputabila ? ' (neimputabilă — nedeductibilă fiscal)' : ''))];
    },
  },
  // Creanta devenita incerta: se REclasifica pe 4118, ca soldul lui 4111 sa arate doar creantele
  // curente. Contul lipsea din plan, desi ajustarea 6814 = 491 si pierderea 654 existau — deci se
  // putea constitui ajustarea pentru o creanta pe care nimic n-o marca drept incerta.
  {
    id: 'client_incert',
    nume: 'Client devenit incert / in litigiu (4118 = 4111)',
    grup: 'Diverse',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'suma', label: 'Creanta reclasificata (cu TVA)', type: 'number', required: true }],
    build: (d) => [L('4118', '4111', d.suma, 'Creanță reclasificată la clienți incerți')],
  },
  {
    id: 'imputare_lipsa',
    nume: 'Imputare lipsa la inventar (catre gestionar)',
    grup: 'Stocuri',
    fields: [F.data, F.partener, F.document,
      { name: 'valoareImputata', label: 'Valoare imputata (fara TVA)', type: 'number', required: true },
      { name: 'cota', label: 'Cota TVA (%)', type: 'number', default: 0, fiscalRate: 'tvaStandard' },
      { name: 'contCreanta', label: 'Cont creanta', type: 'select',
        options: [{ value: '4282', label: '4282 Alte creante personal' }, { value: '461', label: '461 Debitori diversi' }], default: '4282' }],
    build: (d) => {
      const tva = round2((d.valoareImputata * (Number(d.cota) || rate(d, 'tvaStandard'))) / 100);
      const o = [L(d.contCreanta || '4282', '7588', d.valoareImputata, 'Imputare lipsă la inventar - venit')];
      if (tva > 0) o.push(L(d.contCreanta || '4282', '4427', tva, 'TVA aferentă imputării'));
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
    build: (d) => [L(d.contTaxa || '446', d.cont || '5121', d.suma, 'Plata taxe/impozite către buget')],
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
      if (d.amortizare > 0) lines.push(L(d.contAmort || '281', d.contImob || '2131', d.amortizare, 'Scăderea amortizării cumulate'));
      if (ramas > 0) lines.push(L('6583', d.contImob || '2131', ramas, 'Valoarea rămasă neamortizată'));
      return lines;
    },
  },
  {
    id: 'avans_incasat_client',
    nume: 'Avans incasat de la client (419, fara factura de avans)',
    grup: 'Trezorerie',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasat in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '419', d.suma, 'Avans încasat de la client (fără factura de avans)')],
  },
  {
    id: 'avans_platit_furnizor',
    nume: 'Avans platit catre furnizor (409, fara factura de avans)',
    grup: 'Trezorerie',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L('409', d.cont || '5121', d.suma, 'Avans plătit către furnizor (fără factura de avans)')],
  },

];
