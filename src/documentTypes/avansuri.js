'use strict';

// AVANSURI FACTURATE — vezi index.js pentru contractul tipurilor.

const { L, F } = require('./helpers');

module.exports = [
  // ─────────────── AVANSURI FACTURATE (factura de avans, cu TVA exigibila) ───────────────
  // TVA e exigibila la incasarea avansului (art. 282 Cod fiscal) — factura de avans o colecteaza.
  // Fluxul: factura de avans -> incasarea (tip "Incasare de la client", 5121 = 4111) -> la livrare,
  // factura finala (tip normal de vanzare) + REGULARIZAREA avansului (storno in rosu, 419 se inchide).
  {
    id: 'factura_avans_client',
    nume: 'Factura de avans emisa (client): 4111 = 419 + 4427',
    grup: 'Vanzari',
    // art. 319 alin. (6): incasarea unui avans se factureaza
    eFactura: 'da',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'baza', label: 'Avans facturat (fara TVA)', type: 'number', required: true }, F.tva, F.cota],
    build: (d) => {
      const lines = [L('4111', '419', d.baza, 'Factura de avans - avans facturat (fără TVA)')];
      if (d.tva > 0) lines.push(L('4111', '4427', d.tva, 'TVA colectată aferentă avansului'));
      return lines;
    },
  },
  {
    id: 'regularizare_avans_client',
    nume: 'Regularizare avans client la factura finala (storno avans, in rosu)',
    grup: 'Vanzari',
    // NU e un document de sine statator: comentariul din `build` o spune — se inregistreaza
    // IMPREUNA cu factura finala, care pleaca ea in e-Factura. Art. 319 alin. (6) cere ca avansul
    // sa se regularizeze PE factura de livrare, nu printr-un document separat. Randata singura ar
    // fi iesit o „factura" cu sume negative, adica un document care nu exista.
    eFactura: 'nu',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'refFactura', label: 'Factura de avans stornata (referinta)', type: 'text' },
      { name: 'baza', label: 'Avans stornat (fara TVA)', type: 'number', required: true }, F.tva, F.cota],
    build: (d) => {
      // se inregistreaza IMPREUNA cu factura finala de livrare (introdusa separat, ca vanzare normala)
      const lines = [L('4111', '419', -d.baza, 'Storno avans facturat (în roșu)')];
      if (d.tva > 0) lines.push(L('4111', '4427', -d.tva, 'Storno TVA aferentă avansului (în roșu)'));
      return lines;
    },
  },
  {
    id: 'factura_avans_furnizor',
    nume: 'Factura de avans primita (furnizor): 409 + 4426 = 401',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document,
      { name: 'baza', label: 'Avans facturat (fara TVA)', type: 'number', required: true }, F.tva, F.cota],
    build: (d) => {
      const lines = [L('409', '401', d.baza, 'Factura de avans primită - avans (fără TVA)')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibilă aferentă avansului'));
      return lines;
    },
  },
  {
    id: 'regularizare_avans_furnizor',
    nume: 'Regularizare avans furnizor la factura finala (storno, in rosu)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document,
      { name: 'refFactura', label: 'Factura de avans stornata (referinta)', type: 'text' },
      { name: 'baza', label: 'Avans stornat (fara TVA)', type: 'number', required: true }, F.tva, F.cota],
    build: (d) => {
      const lines = [L('409', '401', -d.baza, 'Storno avans facturat furnizor (în roșu)')];
      if (d.tva > 0) lines.push(L('4426', '401', -d.tva, 'Storno TVA aferentă avansului (în roșu)'));
      return lines;
    },
  },
];
