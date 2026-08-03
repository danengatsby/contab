'use strict';

// SALARII — vezi index.js pentru contractul tipurilor.

const { L, F, TROZ } = require('./helpers');
const fiscal = require('../fiscal');

module.exports = [
  // ─────────────────────────── SALARII ────────────────────────────
  {
    id: 'stat_plata',
    nume: 'Stat de plata salarii (calcul automat din brut)',
    grup: 'Salarii',
    fields: [
      F.data,
      { name: 'brut', label: 'Total salarii brute', type: 'number', required: true },
      { name: 'neimpozabil', label: 'Suma neimpozabila (ex. salariu minim)', type: 'number', default: 0 },
      { name: 'cas', label: 'CAS 25% (gol = auto)', type: 'number', default: 0 },
      { name: 'cass', label: 'CASS 10% (gol = auto)', type: 'number', default: 0 },
      { name: 'impozit', label: 'Impozit 10% (gol = auto)', type: 'number', default: 0 },
      { name: 'cam', label: 'CAM 2,25% (gol = auto)', type: 'number', default: 0 },
      F.analiticAngajat,
    ],
    build: (d) => {
      let { cas, cass, impozit, cam } = d;
      // daca toate contributiile sunt 0, se calculeaza automat din brut (cotele 2026)
      if (d.brut > 0 && !cas && !cass && !impozit && !cam) {
        const p = fiscal.payroll(d.brut, d.neimpozabil);
        cas = p.cas; cass = p.cass; impozit = p.impozit; cam = p.cam;
      }
      const lines = [L('641', '421', d.brut, 'Salarii brute datorate')];
      if (cas > 0) lines.push(L('421', '4315', cas, 'Reținere CAS 25%'));
      if (cass > 0) lines.push(L('421', '4316', cass, 'Reținere CASS 10%'));
      if (impozit > 0) lines.push(L('421', '444', impozit, 'Reținere impozit pe salarii 10%'));
      if (cam > 0) lines.push(L('646', '436', cam, 'CAM 2,25% (angajator)'));
      return lines;
    },
  },
  {
    id: 'plata_salarii',
    nume: 'Plata salarii nete',
    grup: 'Salarii',
    fields: [F.data, F.suma,
      { name: 'cont', label: 'Platita din', type: 'select', options: TROZ, default: '5121' }, F.analiticAngajat],
    build: (d) => [L('421', d.cont || '5121', d.suma, 'Plata salarii nete')],
  },
  {
    id: 'tichete_masa',
    nume: 'Tichete de masa acordate salariatilor',
    grup: 'Salarii',
    fields: [F.data, F.suma, F.analiticAngajat],
    build: (d) => [L('642', '5328', d.suma, 'Tichete de masă acordate')],
  },
  {
    id: 'concediu_medical_angajator',
    nume: 'Concediu medical - indemnizatie suportata de angajator (primele 5 zile)',
    grup: 'Salarii',
    fields: [F.data, F.suma, F.analiticAngajat],
    build: (d) => [L('6458', '423', d.suma, 'Indemnizație concediu medical (angajator)')],
  },
  {
    id: 'concediu_medical_fnuass',
    nume: 'Concediu medical - indemnizatie suportata de FNUASS (de recuperat)',
    grup: 'Salarii',
    fields: [F.data, F.suma, F.analiticAngajat],
    build: (d) => [L('4373', '423', d.suma, 'Indemnizație concediu medical (FNUASS - de recuperat)')],
  },
  {
    id: 'recuperare_fnuass',
    nume: 'Incasare indemnizatii concedii medicale de la FNUASS',
    grup: 'Salarii',
    fields: [F.data, F.suma,
      { name: 'cont', label: 'Incasata in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '4373', d.suma, 'Recuperare indemnizații de la FNUASS')],
  },

];
