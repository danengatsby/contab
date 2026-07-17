'use strict';

// TREZORERIE — vezi index.js pentru contractul tipurilor.

const { L, F, TROZ } = require('./helpers');

module.exports = [
  // ─────────────────────────── TREZORERIE ─────────────────────────
  {
    id: 'incasare_client',
    nume: 'Incasare de la client (chitanta / extras)',
    grup: 'Trezorerie',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasata in', type: 'select', options: TROZ, default: '5121' }, F.analiticBanca],
    build: (d) => [L(d.cont || '5121', '4111', d.suma, 'Incasare de la client')],
  },
  {
    id: 'plata_furnizor',
    nume: 'Plata catre furnizor (chitanta / extras / OP)',
    grup: 'Trezorerie',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platita din', type: 'select', options: TROZ, default: '5121' },
      { name: 'contFz', label: 'Cont furnizor', type: 'account', default: '401' }, F.analiticBanca],
    build: (d) => [L(d.contFz || '401', d.cont || '5121', d.suma, 'Plata catre furnizor')],
  },
  {
    id: 'depunere_numerar',
    nume: 'Depunere numerar la banca',
    grup: 'Trezorerie',
    fields: [F.data, F.document, F.suma],
    build: (d) => [
      L('581', '5311', d.suma, 'Ridicare numerar din casa - viramente interne'),
      L('5121', '581', d.suma, 'Depunere numerar in banca'),
    ],
  },
  {
    id: 'ridicare_numerar',
    nume: 'Ridicare numerar din banca',
    grup: 'Trezorerie',
    fields: [F.data, F.document, F.suma],
    build: (d) => [
      L('581', '5121', d.suma, 'Ridicare numerar din banca - viramente interne'),
      L('5311', '581', d.suma, 'Intrare numerar in casa'),
    ],
  },
  {
    id: 'comision_bancar',
    nume: 'Comision bancar (extras)',
    grup: 'Trezorerie',
    fields: [F.data, F.document, F.suma, F.analiticBanca],
    build: (d) => [L('627', '5121', d.suma, 'Cheltuieli cu serviciile bancare')],
  },

];
