'use strict';

// RETINERI LA SURSA + PRO-RATA/BUNURI DE CAPITAL — vezi index.js pentru contractul tipurilor.

const { L, F, TROZ } = require('./helpers');
const { round2 } = require('../util');
const fiscal = require('../fiscal'); // cotele NU se hardcodeaza — sursa unica e fiscalConfig

// Optiunile de plata: trezoreria obisnuita plus „neplatita inca", care lasa datoria pe 462.
const PLATA_RETINERE = TROZ.concat([{ value: '462', label: 'Neplătită încă (rămâne pe 462)' }]);

/** Articolul unei retineri la sursa: cheltuiala pe brut, impozitul retinut, plata netului.
 *  462 se deschide si se inchide in acelasi articol cand plata se face pe loc; altfel ramane cu
 *  soldul net de platit. */
function construieste(fel, d, contCheltuiala, explicatie) {
  const r = fiscal.retinereLaSursa(fel, d.baza, d.cota);
  const lines = [];
  if (r.brut > 0) lines.push(L(contCheltuiala, '462', r.brut, explicatie + ' (brut)'));
  if (r.impozit > 0) {
    lines.push(L('462', '446', r.impozit,
      'Impozit reținut la sursă (' + r.cota + '% din baza de ' + r.baza + ' lei)'));
  }
  const cont = String(d.cont || '5121');
  if (cont !== '462' && r.net > 0) lines.push(L('462', cont, r.net, explicatie + ' — plata netului'));
  return lines;
}

module.exports = [
  // ───────────── IMPOZIT RETINUT LA SURSA (pentru D205) ─────────────
  //
  // MONOGRAFIA trece prin 462 „Creditori diversi", nu direct pe trezorerie. Varianta veche
  // (`612 = 5121` + `612 = 446`) recunostea cheltuiala LA PLATA, nu la data la care era datorata:
  // o chirie a lunii decembrie platita in ianuarie cadea in alt exercitiu, cu efect direct in
  // impozitul pe profit. In plus, datoria fata de persoana fizica nu exista niciodata in balanta,
  // deci nu aparea nici in fisa analitica pe partener.
  //
  // Plata ramane pe acelasi document (cazul obisnuit: se plateste pe loc), dar contul de plata are
  // si optiunea „neplatita inca" — atunci articolul se opreste dupa retinere, iar soldul lui 462
  // arata cat se mai datoreaza. Asa acopera si cazul in care plata vine mai tarziu, fara un tip
  // de document in plus si fara o bifa care se poate uita.
  //
  // BAZA impozabila vine din `fiscal.retinereLaSursa` — aceeasi functie pe care o citeste si D205.
  // Cat timp erau doua calcule, declaratia raporta alta baza decat cea pe care se retinuse.
  {
    id: 'chirie_pf',
    nume: 'Chirie datorata unei persoane fizice (impozit retinut la sursa, D205)',
    grup: 'Retineri la sursa',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'baza', label: 'Chirie bruta (lei)', type: 'number', required: true },
      { name: 'cota', label: 'Cota impozit (%)', type: 'number', default: fiscal.FISCAL.impozitVenit },
      { name: 'cont', label: 'Platita din', type: 'select', options: PLATA_RETINERE, default: '5121' }],
    build: (d) => construieste('chirii', d, '612', 'Chirie datorată persoanei fizice'),
  },
  {
    id: 'premiu_pf',
    nume: 'Premiu acordat unei persoane fizice (impozit retinut la sursa, D205)',
    grup: 'Retineri la sursa',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'baza', label: 'Premiu brut (lei)', type: 'number', required: true },
      { name: 'cota', label: 'Cota impozit (%)', type: 'number', default: fiscal.FISCAL.impozitVenit },
      { name: 'cont', label: 'Platit din', type: 'select', options: PLATA_RETINERE, default: '5311' }],
    build: (d) => construieste('premii', d, '623', 'Premiu acordat persoanei fizice'),
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
  // Lipsa in gestiune NEIMPUTABILA: TVA-ul dedus la achizitie trebuie ajustat (art. 304), fiindca
  // bunul nu mai serveste operatiunilor taxabile. `diferente_inventar` muta doar costul, deci
  // ajustarea ramanea nefacuta — o constatare tipica la control. Cheltuiala e si ea nedeductibila
  // la impozitul pe profit (art. 25(4)(c)) daca nu e imputata si nu e asigurata.
  {
    id: 'ajustare_tva_lipsa',
    nume: 'Ajustare TVA pentru lipsa neimputabila in gestiune (art. 304)',
    grup: 'Regularizari',
    fields: [F.data, F.document,
      { name: 'baza', label: 'Valoarea bunurilor lipsa (fara TVA)', type: 'number', required: true },
      { name: 'cota', label: 'Cota TVA dedusa la achizitie (%)', type: 'number', default: fiscal.FISCAL.tvaStandard }],
    build: (d) => {
      const tva = round2(((Number(d.baza) || 0) * (Number(d.cota) || fiscal.FISCAL.tvaStandard)) / 100);
      return tva > 0
        ? [L('635', '4426', tva, 'Ajustarea TVA dedusă pentru lipsa neimputabilă (art. 304)')]
        : [];
    },
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
