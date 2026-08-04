'use strict';

// CUMPARARI — vezi index.js pentru contractul tipurilor.

const { L, F } = require('./helpers');
const fiscal = require('../fiscal');
const { round2 } = require('../util');

module.exports = [
  // ─────────────────────────── CUMPARARI ──────────────────────────
  {
    id: 'factura_cumparare_marfuri',
    nume: 'Factura cumparare marfuri',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.proRataMixt],
    build: (d) => {
      const lines = [L('371', '401', d.baza, 'Cumpărare mărfuri (intrare în stoc)')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  {
    id: 'factura_cumparare_materii',
    nume: 'Factura cumparare materii prime/materiale',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.proRataMixt,
      { name: 'contStoc', label: 'Cont stoc', type: 'account', default: '301' }],
    build: (d) => {
      const lines = [L(d.contStoc || '301', '401', d.baza, 'Cumpărare materii/materiale')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  // ── CUT-OFF: bunul/serviciul a sosit, factura NU ─────────────────────────────────────────────
  // Contul 408 era in plan, in bilant si in SAF-T, dar NICIUN tip de document nu-l producea: la
  // inchiderea lunii, utilitatile consumate si facturate ulterior nu aveau unde sa meargă, deci
  // cheltuiala cadea in luna gresita. TVA-ul e NEEXIGIBIL pana la primirea facturii (4428, nu
  // 4426): dreptul de deducere se naste cu factura, nu cu consumul. Perechea `sosire_factura`
  // face regularizarea.
  {
    id: 'factura_nesosita',
    nume: 'Cheltuiala fara factura (cut-off la inchiderea lunii) — 408',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota,
      { name: 'contChelt', label: 'Cont cheltuiala/stoc', type: 'account', default: '628' }],
    build: (d) => {
      const lines = [L(d.contChelt || '628', '408', d.baza, 'Cheltuială aferentă lunii, factură nesosită')];
      if (d.tva > 0) lines.push(L('4428', '408', d.tva, 'TVA neexigibilă (dreptul de deducere se naște cu factura)'));
      return lines;
    },
  },
  {
    id: 'sosire_factura_nesosita',
    nume: 'Sosirea facturii pentru o cheltuiala din 408 (regularizare)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('408', '401', round2((Number(d.baza) || 0) + (Number(d.tva) || 0)), 'Factura sosită — datoria devine certă')];
      if (d.tva > 0) lines.push(L('4426', '4428', d.tva, 'TVA devine deductibilă la primirea facturii'));
      return lines;
    },
  },
  {
    id: 'factura_utilitati',
    nume: 'Factura utilitati (energie, apa)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.proRataMixt],
    build: (d) => {
      const lines = [L('605', '401', d.baza, 'Cheltuieli cu energia și apa')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  {
    id: 'factura_servicii_primita',
    nume: 'Factura servicii primita (chirie, telecom, onorarii...)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.auto50, F.proRataMixt,
      { name: 'contChelt', label: 'Cont cheltuiala', type: 'account', default: '628' }],
    build: (d) => {
      const lines = [L(d.contChelt || '628', '401', d.baza, 'Cheltuieli cu servicii primite')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  {
    id: 'factura_combustibil',
    nume: 'Factura/bon combustibil (cu CUI)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.auto50],
    build: (d) => {
      const lines = [L('6022', '401', d.baza, 'Cheltuieli privind combustibilii')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  {
    id: 'factura_imobilizare',
    nume: 'Factura achizitie imobilizare (mijloc fix)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.auto50,
      { name: 'contImob', label: 'Cont imobilizare', type: 'account', default: '2131' }],
    build: (d) => {
      const lines = [L(d.contImob || '2131', '404', d.baza, 'Achiziție imobilizare')];
      if (d.tva > 0) lines.push(L('4426', '404', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  {
    id: 'achizitie_intracomunitara',
    nume: 'Achizitie intracomunitara bunuri (taxare inversa)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.cota,
      { name: 'contStoc', label: 'Cont stoc/cheltuiala', type: 'account', default: '371' },
      F.codNC, F.masaNeta, F.naturaTranz, F.conditieLivrare],
    build: (d) => {
      const tva = round2((Number(d.baza) * Number(d.cota || fiscal.FISCAL.tvaStandard)) / 100);
      return [
        L(d.contStoc || '371', '401', d.baza, 'Achiziție intracomunitară (bază)'),
        L('4426', '4427', tva, 'Taxare inversă - TVA deductibilă și colectată'),
      ];
    },
  },
  {
    id: 'livrare_intracomunitara',
    nume: 'Livrare intracomunitara bunuri (scutita)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza,
      F.codNC, F.masaNeta, F.naturaTranz, F.conditieLivrare],
    build: (d) => [L('4111', '707', d.baza, 'Livrare intracomunitară (scutită cu drept de deducere)')],
  },
  {
    id: 'taxare_inversa_interna_achizitie',
    nume: 'Achizitie cu taxare inversa interna (art. 331 — cereale, lemn, deseuri, constructii...)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.cota, F.codCategorie331,
      { name: 'contStoc', label: 'Cont stoc/cheltuiala/imobilizare', type: 'account', default: '371' }],
    build: (d) => {
      const tva = round2((Number(d.baza) * Number(d.cota || fiscal.FISCAL.tvaStandard)) / 100);
      return [
        L(d.contStoc || '371', '401', d.baza, 'Achiziție cu taxare inversă internă (bază)'),
        L('4426', '4427', tva, 'Taxare inversă internă - TVA deductibilă și colectată'),
      ];
    },
  },
  {
    id: 'taxare_inversa_interna_livrare',
    nume: 'Livrare cu taxare inversa interna (factura emisa fara TVA)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.codCategorie331,
      { name: 'contVenit', label: 'Cont venit', type: 'account', default: '707' }],
    build: (d) => [L('4111', d.contVenit || '707', d.baza, 'Livrare cu taxare inversă internă (fără TVA - mențiune pe factura)')],
  },
  {
    id: 'reducere_comerciala_acordata',
    nume: 'Reducere comerciala acordata clientului (ulterioara facturarii)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('709', '4111', d.baza, 'Reducere comercială acordată')];
      if (d.tva > 0) lines.push(L('4427', '4111', d.tva, 'TVA aferentă reducerii (storno colectată)'));
      return lines;
    },
  },
  {
    id: 'reducere_comerciala_primita',
    nume: 'Reducere comerciala primita de la furnizor (ulterioara facturarii)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('401', '609', d.baza, 'Reducere comercială primită')];
      if (d.tva > 0) lines.push(L('401', '4426', d.tva, 'TVA aferentă reducerii (storno deductibilă)'));
      return lines;
    },
  },
  {
    id: 'scont_acordat',
    nume: 'Scont de decontare acordat (client care plateste in avans)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.document, F.suma],
    build: (d) => [L('667', '4111', d.suma, 'Scont de decontare acordat')],
  },
  {
    id: 'scont_primit',
    nume: 'Scont de decontare obtinut (plata in avans catre furnizor)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.document, F.suma],
    build: (d) => [L('401', '767', d.suma, 'Scont de decontare obținut')],
  },

];
