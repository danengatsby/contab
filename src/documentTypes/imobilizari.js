'use strict';

// LEASING FINANCIAR + IMOBILIZARI (in curs, reevaluare, CEDARE) — vezi index.js pentru contract.

const { L, F, TROZ } = require('./helpers');
const { round2 } = require('../util');

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
    // Campul `leasingRata` NU intra in liniile monografiei: alege un contract si o luna, iar
    // formularul completeaza principalul/dobanda/TVA din grafic. Referinta si fotografia ratei
    // se pastreaza insa pe ARTICOL (`leasingRef`), pentru unicitate si trasabilitate. Cifrele raman
    // editabile — o rata restanta sau o regularizare nu trebuie blocata de grafic — iar `build`
    // ramane pur, pe valorile facturii.
    fields: [F.data, F.partener, F.cuiFurnizor, F.document,
      { name: 'leasingRata', label: 'Preia rata din contractul de leasing', type: 'leasing' },
      { name: 'principal', label: 'Principal (rata capital, 167)', type: 'number', required: true },
      { name: 'dobanda', label: 'Dobanda (666)', type: 'number', default: 0 },
      F.tva, F.cota, F.proRataMixt],
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

  // ───────────────────── VANZAREA UNUI MIJLOC FIX ─────────────────────
  // Lipsea complet: exista casarea (scoaterea din uz), dar nu si CEDAREA cu titlu oneros. Sunt
  // doua operatiuni distincte, iar a doua are si venit, si TVA. Contul 7583 nu exista in plan,
  // deci nici nu se putea improviza cu o nota libera fara sa fie adaugat.
  //
  // Monografia are DOUA parti, si amandoua sunt obligatorii:
  //   (1) vanzarea propriu-zisa:  461 = 7583 (pretul) + 461 = 4427 (TVA)
  //   (2) scoaterea din evidenta: 281x = 21x (amortizarea cumulata) + 6583 = 21x (valoarea ramasa)
  // Partea (2) e cea uitata de obicei: fara ea activul ramane in bilant desi a fost vandut, iar
  // rezultatul cedarii (venit minus valoare ramasa) iese fals.
  {
    id: 'vanzare_mijloc_fix',
    nume: 'Vanzare mijloc fix (cedare cu titlu oneros)',
    grup: 'Imobilizari',
    // se factureaza ca orice livrare; creanta sta pe 461, nu pe 4111
    eFactura: 'da',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'contImob', label: 'Cont imobilizare', type: 'account', default: '2131' },
      { name: 'pret', label: 'Pret de vanzare (fara TVA)', type: 'number', required: true },
      F.tva, F.cota,
      { name: 'valoare', label: 'Valoarea de intrare a activului', type: 'number', required: true },
      { name: 'amortizare', label: 'Amortizare cumulata pana la data vanzarii', type: 'number', default: 0 },
      { name: 'contAmort', label: 'Cont amortizare', type: 'account', default: '281' }],
    build: (d) => {
      const cont = d.contImob || '2131';
      const ramas = round2((d.valoare || 0) - (d.amortizare || 0));
      const lines = [L('461', '7583', d.pret, 'Venit din vânzarea activului')];
      if (d.tva > 0) lines.push(L('461', '4427', d.tva, 'TVA colectată la cedare'));
      if (d.amortizare > 0) lines.push(L(d.contAmort || '281', cont, d.amortizare, 'Scăderea amortizării cumulate'));
      if (ramas > 0) lines.push(L('6583', cont, ramas, 'Valoarea rămasă neamortizată a activului cedat'));
      return lines;
    },
  },

  // ───────────────────── IMOBILIZARI IN CURS (231) ─────────────────────
  {
    id: 'imobilizare_in_curs',
    nume: 'Imobilizare in curs - achizitie (231 = 404)',
    grup: 'Imobilizari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.proRataMixt],
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
