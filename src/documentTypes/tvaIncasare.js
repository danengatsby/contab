'use strict';

// TVA LA INCASARE — vezi index.js pentru contractul tipurilor.

const { L, F } = require('./helpers');

module.exports = [
  // ───────────────────── TVA LA INCASARE (regim special, 4428) ─────────────────────
  {
    id: 'factura_vanzare_incasare',
    nume: 'Factura vanzare (TVA la incasare)',
    grup: 'TVA la incasare',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota,
      { name: 'contVenit', label: 'Cont de venit', type: 'account', default: '707' }],
    build: (d) => {
      const lines = [L('4111', d.contVenit || '707', d.baza, 'Venituri (factura emisa)')];
      if (d.tva > 0) lines.push(L('4111', '4428', d.tva, 'TVA neexigibila (la incasare)'));
      return lines;
    },
  },
  {
    id: 'factura_cumparare_incasare',
    nume: 'Factura cumparare (TVA la incasare)',
    grup: 'TVA la incasare',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota,
      { name: 'contCheltStoc', label: 'Cont cheltuiala/stoc', type: 'account', default: '371' }],
    build: (d) => {
      const lines = [L(d.contCheltStoc || '371', '401', d.baza, 'Achizitie (factura primita)')];
      if (d.tva > 0) lines.push(L('4428', '401', d.tva, 'TVA neexigibila deductibila (la plata)'));
      return lines;
    },
  },
  {
    id: 'exigibilitate_tva_colectata',
    nume: 'Exigibilitate TVA colectata (la incasare factura)',
    grup: 'TVA la incasare',
    fields: [F.data, F.partener, F.document, { name: 'tva', label: 'TVA devenita exigibila', type: 'number', required: true }],
    build: (d) => [L('4428', '4427', d.tva, 'TVA colectata devenita exigibila la incasare')],
  },
  {
    id: 'exigibilitate_tva_deductibila',
    nume: 'Exigibilitate TVA deductibila (la plata factura)',
    grup: 'TVA la incasare',
    fields: [F.data, F.partener, F.document, { name: 'tva', label: 'TVA devenita exigibila', type: 'number', required: true }],
    build: (d) => [L('4426', '4428', d.tva, 'TVA deductibila devenita exigibila la plata')],
  },

];
