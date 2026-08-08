'use strict';

// VANZARI — vezi index.js pentru contractul tipurilor.

const { L, F, TROZ } = require('./helpers');

module.exports = [
  // ─────────────────────────── VANZARI ───────────────────────────
  {
    id: 'factura_vanzare_marfuri',
    nume: 'Factura vanzare marfuri',
    grup: 'Vanzari',
    eFactura: 'da',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota, F.stoc,
      { name: 'cost', label: 'Cost marfa vanduta — manual (doar daca NU folosesti descarcarea din stoc)', type: 'number', default: 0 }, F.items],
    build: (d) => {
      const lines = [
        L('4111', '707', d.baza, 'Venituri din vânzarea mărfurilor'),
      ];
      if (d.tva > 0) lines.push(L('4111', '4427', d.tva, 'TVA colectată'));
      if (d.cost > 0) lines.push(L('607', '371', d.cost, 'Descărcare gestiune - cost marfă vândută'));
      return lines;
    },
  },
  {
    id: 'factura_vanzare_produse',
    nume: 'Factura vanzare produse finite',
    grup: 'Vanzari',
    eFactura: 'da',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota, F.items],
    build: (d) => {
      const lines = [L('4111', '701', d.baza, 'Venituri din vânzarea produselor finite')];
      if (d.tva > 0) lines.push(L('4111', '4427', d.tva, 'TVA colectată'));
      return lines;
    },
  },
  {
    id: 'factura_vanzare_servicii',
    nume: 'Factura prestari servicii (emisa)',
    grup: 'Vanzari',
    eFactura: 'da',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota, F.items],
    build: (d) => {
      const lines = [L('4111', '704', d.baza, 'Venituri din servicii prestate')];
      if (d.tva > 0) lines.push(L('4111', '4427', d.tva, 'TVA colectată'));
      return lines;
    },
  },
  {
    id: 'bon_fiscal_z',
    nume: 'Raport Z / vanzare cu amanuntul (numerar)',
    grup: 'Vanzari',
    // raport Z = totalizatorul zilei de casa de marcat, nu o factura
    eFactura: 'nu',
    fields: [F.data, F.document, F.baza, F.tva, F.cota,
      { name: 'incasare', label: 'Incasata in', type: 'select', options: TROZ, default: '5311' }],
    build: (d) => {
      const lines = [L(d.incasare || '5311', '707', d.baza, 'Vânzare cu amănuntul')];
      if (d.tva > 0) lines.push(L(d.incasare || '5311', '4427', d.tva, 'TVA colectată aferentă'));
      return lines;
    },
  },

];
