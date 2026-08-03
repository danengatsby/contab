'use strict';

// LEASING FINANCIAR + IMOBILIZARI IN CURS — vezi index.js pentru contractul tipurilor.

const { L, F, TROZ } = require('./helpers');

module.exports = [
  // ───────────────────────── LEASING FINANCIAR ─────────────────────────
  {
    id: 'leasing_intrare',
    nume: 'Intrare imobilizare in leasing financiar',
    grup: 'Leasing',
    fields: [F.data, F.partener, F.document,
      { name: 'contImob', label: 'Cont imobilizare (2131/2133...)', type: 'account', default: '2133' },
      { name: 'valoare', label: 'Valoarea finantata (fara TVA)', type: 'number', required: true }],
    build: (d) => [L(d.contImob || '2133', '167', d.valoare, 'Imobilizare în leasing financiar + datorie')],
  },
  {
    id: 'factura_leasing',
    nume: 'Factura rata de leasing (principal + dobanda + TVA)',
    grup: 'Leasing',
    // Campul `leasingRata` NU intra in monografie: alege un contract si o luna, iar formularul isi
    // completeaza singur principalul, dobanda si TVA-ul din graficul contractului (ruta
    // /api/leasing-contracts/:id/rata). Cifrele raman editabile — o rata restanta sau o
    // regularizare nu trebuie sa fie blocata de grafic — si `build` ramane pur, pe ele.
    fields: [F.data, F.partener, F.cuiFurnizor, F.document,
      { name: 'leasingRata', label: 'Preia rata din contractul de leasing', type: 'leasing' },
      { name: 'principal', label: 'Principal (rata capital, 167)', type: 'number', required: true },
      { name: 'dobanda', label: 'Dobanda (666)', type: 'number', default: 0 },
      F.tva, F.cota],
    build: (d) => {
      const lines = [L('167', '404', d.principal, 'Rata de capital leasing')];
      if (d.dobanda > 0) lines.push(L('666', '404', d.dobanda, 'Dobânda leasing'));
      if (d.tva > 0) lines.push(L('4426', '404', d.tva, 'TVA deductibilă aferentă ratei'));
      return lines;
    },
  },
  {
    id: 'plata_leasing',
    nume: 'Plata rata de leasing',
    grup: 'Leasing',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L('404', d.cont || '5121', d.suma, 'Plata rata de leasing')],
  },

  // ───────────────────── IMOBILIZARI IN CURS (231) ─────────────────────
  {
    id: 'imobilizare_in_curs',
    nume: 'Imobilizare in curs - achizitie (231 = 404)',
    grup: 'Imobilizari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('231', '404', d.baza, 'Imobilizare corporală în curs de execuție')];
      if (d.tva > 0) lines.push(L('4426', '404', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  {
    id: 'imobilizare_in_curs_productie',
    nume: 'Imobilizare in curs - productie proprie (231 = 722)',
    grup: 'Imobilizari',
    fields: [F.data, F.document, { name: 'valoare', label: 'Cost productie (fara TVA)', type: 'number', required: true }],
    build: (d) => [L('231', '722', d.valoare, 'Producție de imobilizări în regie proprie')],
  },
  {
    id: 'punere_in_functiune',
    nume: 'Punere in functiune (21x = 231)',
    grup: 'Imobilizari',
    fields: [F.data, F.document,
      { name: 'contImob', label: 'Cont imobilizare (2131/212...)', type: 'account', default: '2131' },
      { name: 'valoare', label: 'Valoarea de intrare', type: 'number', required: true }],
    build: (d) => [L(d.contImob || '2131', '231', d.valoare, 'Recepție și punere în funcțiune')],
  },
  {
    id: 'reevaluare_plus',
    nume: 'Reevaluare imobilizare - plus de valoare (21x = 105)',
    grup: 'Imobilizari',
    fields: [F.data, F.document,
      { name: 'contImob', label: 'Cont imobilizare', type: 'account', default: '212' },
      { name: 'valoare', label: 'Plus de valoare (lei)', type: 'number', required: true }],
    build: (d) => [L(d.contImob || '212', '105', d.valoare, 'Plus din reevaluare (rezervă)')],
  },
  {
    id: 'reevaluare_minus',
    nume: 'Reevaluare imobilizare - minus de valoare',
    grup: 'Imobilizari',
    fields: [F.data, F.document,
      { name: 'contImob', label: 'Cont imobilizare', type: 'account', default: '212' },
      { name: 'dinRezerva', label: 'Acoperit din rezerva 105 (lei)', type: 'number', default: 0 },
      { name: 'peCheltuiala', label: 'Pe cheltuiala 655 (lei)', type: 'number', default: 0 }],
    build: (d) => {
      const lines = [];
      if (d.dinRezerva > 0) lines.push(L('105', d.contImob || '212', d.dinRezerva, 'Minus din reevaluare (din rezervă)'));
      if (d.peCheltuiala > 0) lines.push(L('655', d.contImob || '212', d.peCheltuiala, 'Minus din reevaluare (cheltuială)'));
      return lines;
    },
  },

];
