'use strict';

// RETINERI LA SURSA + PRO-RATA/BUNURI DE CAPITAL — vezi index.js pentru contractul tipurilor.

const { L, F, TROZ } = require('./helpers');
const { round2 } = require('../util');
const fiscal = require('../fiscal'); // cotele NU se hardcodeaza — sursa unica e fiscalConfig

module.exports = [
  // ───────────── IMPOZIT RETINUT LA SURSA (pentru D205) ─────────────
  {
    id: 'chirie_pf',
    nume: 'Chirie platita unei persoane fizice (impozit retinut la sursa, D205)',
    grup: 'Retineri la sursa',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'baza', label: 'Chirie bruta (lei)', type: 'number', required: true },
      { name: 'cota', label: 'Cota impozit (%)', type: 'number', default: fiscal.FISCAL.impozitVenit },
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => {
      // Din 2024: venitul net din chirii = brut - 20% cota forfetara; impozitul (10%) se aplica
      // la NET => efectiv 8% din brut (art. 84 Cod fiscal, OG 16/2022 rev.).
      const impozit = round2((d.baza || 0) * 0.8 * (d.cota || fiscal.FISCAL.impozitVenit) / 100);
      const net = round2((d.baza || 0) - impozit);
      const lines = [];
      if (net > 0) lines.push(L('612', d.cont || '5121', net, 'Chirie plătită persoanei fizice (după reținere)'));
      if (impozit > 0) lines.push(L('612', '446', impozit, 'Impozit pe chirie reținut la sursă (10% din brut - 20% forfetar)'));
      return lines;
    },
  },
  {
    id: 'premiu_pf',
    nume: 'Premiu acordat unei persoane fizice (impozit retinut la sursa, D205)',
    grup: 'Retineri la sursa',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'baza', label: 'Premiu brut (lei)', type: 'number', required: true },
      { name: 'cota', label: 'Cota impozit (%)', type: 'number', default: fiscal.FISCAL.impozitVenit },
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5311' }],
    build: (d) => {
      const impozit = round2((d.baza || 0) * (d.cota || fiscal.FISCAL.impozitVenit) / 100);
      const net = round2((d.baza || 0) - impozit);
      const lines = [];
      if (net > 0) lines.push(L('623', d.cont || '5311', net, 'Premiu acordat persoanei fizice (net)'));
      if (impozit > 0) lines.push(L('623', '446', impozit, 'Impozit pe premii reținut la sursă'));
      return lines;
    },
  },

  // ───────────── TVA AVANSAT: PRO-RATA (art. 300) + BUNURI DE CAPITAL (art. 305) ─────────────
  {
    id: 'regularizare_pro_rata',
    nume: 'Regularizare anuala pro-rata TVA (art. 300): definitiva vs provizorie',
    grup: 'Regularizari',
    fields: [F.data, F.document,
      { name: 'suma', label: 'Diferenta de TVA (din raportul Pro-rata)', type: 'number', required: true },
      { name: 'sens', label: 'Sensul regularizarii', type: 'select',
        options: [{ value: 'firma', label: 'In favoarea firmei (mai ai de dedus: 4426 = 635)' }, { value: 'stat', label: 'In favoarea statului (dai TVA inapoi: 635 = 4426)' }], default: 'firma' }],
    build: (d) => (d.sens === 'stat'
      ? [L('635', '4426', d.suma, 'Regularizare pro-rata anuală în favoarea statului (art. 300)')]
      : [L('4426', '635', d.suma, 'Regularizare pro-rata anuală în favoarea firmei (art. 300)')]),
  },
  {
    id: 'ajustare_tva_bunuri_capital',
    nume: 'Ajustare TVA bunuri de capital (art. 305, schimbarea destinatiei/regimului)',
    grup: 'Regularizari',
    fields: [F.data, F.document,
      { name: 'tvaDedusa', label: 'TVA dedusa initial la achizitie', type: 'number', required: true },
      { name: 'durata', label: 'Perioada de ajustare', type: 'select',
        options: [{ value: '5', label: '5 ani (bunuri de capital mobile)' }, { value: '20', label: '20 de ani (bunuri imobile)' }], default: '5' },
      { name: 'aniRamasi', label: 'Ani ramasi din perioada de ajustare (inclusiv anul schimbarii)', type: 'number', required: true },
      { name: 'sens', label: 'Sensul ajustarii', type: 'select',
        options: [{ value: 'stat', label: 'In favoarea statului (dai TVA inapoi: 635 = 4426)' }, { value: 'firma', label: 'In favoarea firmei (mai deduci: 4426 = 635)' }], default: 'stat' }],
    build: (d) => {
      // ajustarea = TVA dedusa x anii ramasi / perioada de ajustare (art. 305 Cod fiscal)
      const durata = Number(d.durata) || 5;
      const ani = Math.max(0, Math.min(Number(d.aniRamasi) || 0, durata));
      const suma = round2(((Number(d.tvaDedusa) || 0) * ani) / durata);
      const expl = 'Ajustare TVA bunuri de capital (art. 305): ' + ani + '/' + durata + ' din TVA dedusa';
      return d.sens === 'firma' ? [L('4426', '635', suma, expl + ' — in favoarea firmei')] : [L('635', '4426', suma, expl + ' — in favoarea statului')];
    },
  },

];
