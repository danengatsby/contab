'use strict';

// PFA + PRODUSE AGRICOLE + AVIZE/FACTURI SIMPLIFICATE — vezi index.js pentru contractul tipurilor.

const { L, F, TROZ } = require('./helpers');
const { round2 } = require('../util');

module.exports = [
  // ───────────── PFA / INTREPRINDERE INDIVIDUALA ─────────────
  // PFA nu distribuie dividende: intreprinzatorul retrage/aporteaza sume prin contul
  // curent al titularului (455) — fara impozit la retragere (venitul se impoziteaza
  // anual, prin Declaratia Unica, pe venitul net al activitatii).
  {
    id: 'retragere_intreprinzator',
    nume: 'Retragere de numerar / banca de catre intreprinzator (PFA)',
    grup: 'Trezorerie',
    entitate: 'pfa',
    fields: [F.data, F.document, F.suma,
      { name: 'cont', label: 'Din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L('455', d.cont || '5121', d.suma, 'Retragere întreprinzător PFA (455 = trezorerie)')],
  },
  {
    id: 'aport_intreprinzator',
    nume: 'Aport de bani al intreprinzatorului in activitate (PFA)',
    grup: 'Trezorerie',
    entitate: 'pfa',
    fields: [F.data, F.document, F.suma,
      { name: 'cont', label: 'In', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '455', d.suma, 'Aport întreprinzător PFA (trezorerie = 455)')],
  },

  // ───────────── PRODUSE AGRICOLE (CARNET DE COMERCIALIZARE) ─────────────
  {
    id: 'achizitie_produse_agricole',
    nume: 'Achizitie produse agricole de la producator PF (fila carnet de comercializare / borderou)',
    grup: 'Cumparari',
    fields: [F.data,
      { name: 'partener', label: 'Producator agricol (nume PF)', type: 'text', required: true },
      { name: 'cuiPartener', label: 'CNP producator (pentru D394)', type: 'text' },
      { name: 'document', label: 'Nr. fila carnet / borderou de achizitie', type: 'text' },
      F.suma,
      { name: 'cont', label: 'Destinatia produselor', type: 'select',
        options: [{ value: '371', label: '371 Marfuri (revanzare)' }, { value: '301', label: '301 Materii prime (procesare)' }], default: '371' },
      { name: 'platitCash', label: 'Platit pe loc in numerar (borderoul tine loc de chitanta)', type: 'checkbox' }],
    build: (d) => {
      // Achizitie de la producator agricol PF pe baza de fila din carnetul de comercializare
      // (Legea 145/2014): fara TVA (PF neinregistrata), fara impozit retinut la sursa
      // (venitul e impozitat la producator pe norma de venit). Datoria: 462 Creditori diversi.
      const lines = [L(d.cont || '371', '462', d.suma, 'Achiziție produse agricole pe fila carnet (fără TVA, Legea 145/2014)')];
      if (d.platitCash) lines.push(L('462', '5311', d.suma, 'Plata producător agricol în numerar (borderou)'));
      return lines;
    },
  },

  // ───────────── AVIZE SI FACTURI SIMPLIFICATE ─────────────
  {
    id: 'aviz_livrare',
    nume: 'Aviz de insotire a marfii (livrare neînfacturata)',
    grup: 'Vanzari',
    // avizul de insotire NU e factura; factura vine separat (vezi facturare_aviz)
    eFactura: 'nu',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota, F.stoc],
    build: (d) => {
      // 418 include si TVA neexigibila (OMFP 1802): exigibilitatea TVA e la LIVRARE,
      // deci se recunoaste pe 4428 la aviz si devine 4427 la facturare.
      const lines = [L('418', '707', d.baza, 'Livrare pe aviz - clienți, facturi de întocmit (418 = 707)')];
      if (d.tva > 0) lines.push(L('418', '4428', d.tva, 'TVA neexigibilă aferentă livrării pe aviz'));
      return lines;
    },
  },
  {
    id: 'facturare_aviz',
    nume: 'Facturare ulterioara aviz (transforma avizul in factura)',
    grup: 'Vanzari',
    // avizul se factureaza pana pe 15 a lunii urmatoare (art. 319 alin. 16)
    eFactura: 'da',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'refFactura', label: 'Aviz facturat (referinta)', type: 'text' },
      F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('4111', '418', round2((Number(d.baza) || 0) + (Number(d.tva) || 0)), 'Facturare aviz - creanță fermă (4111 = 418, cu TVA)')];
      if (d.tva > 0) lines.push(L('4428', '4427', d.tva, 'TVA devenită exigibilă la facturarea avizului'));
      return lines;
    },
  },
  {
    id: 'factura_simplificata',
    nume: 'Factura simplificata (art. 319 Cod fiscal, sub 100 EUR)',
    grup: 'Vanzari',
    // art. 319 alin. (12): bon fiscal cu CUI sub plafon — exceptat de la e-Factura
    eFactura: 'nu',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota,
      { name: 'cont', label: 'Incasata in / pe credit (4111)', type: 'select', options: [{ value: '4111', label: '4111 Clienti (pe credit)' }, { value: '5311', label: '5311 Casa in lei' }, { value: '5121', label: '5121 Banca in lei' }], default: '5311' },
      F.stoc],
    build: (d) => {
      const cont = d.cont || '5311';
      const lines = [L(cont, '707', d.baza, 'Vânzare pe factura simplificată')];
      if (d.tva > 0) lines.push(L(cont, '4427', d.tva, 'TVA colectată (factura simplificată)'));
      return lines;
    },
  },
];
