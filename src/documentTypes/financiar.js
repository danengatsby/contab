'use strict';

// VALUTA/DIF. CURS + PROVIZIOANE + ASOCIATI + DIVIDENDE + SUBVENTII + AVANSURI 471/472 + EFECTE/ACREDITIVE — vezi index.js pentru contractul tipurilor.

const { L, F, TROZ, TVAL } = require('./helpers');
const fiscal = require('../fiscal');
const { round2 } = require('../util');

module.exports = [
  // ───────────────────── VALUTA / DIFERENTE DE CURS ─────────────────────
  {
    id: 'factura_vanzare_valuta',
    nume: 'Factura vanzare in valuta (export/intracom)',
    grup: 'Valuta',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'valuta', label: 'Suma in valuta', type: 'number', required: true },
      { name: 'curs', label: 'Curs valutar (lei/valuta)', type: 'number', required: true },
      { name: 'contVenit', label: 'Cont de venit', type: 'account', default: '707' }],
    build: (d) => [L('4111', d.contVenit || '707', round2((Number(d.valuta) || 0) * (Number(d.curs) || 0)), 'Factura în valută (scutită de TVA)')],
  },
  {
    id: 'diferenta_curs_favorabila',
    nume: 'Diferenta de curs favorabila (castig, 765)',
    grup: 'Valuta',
    fields: [F.data, F.partener, F.document,
      { name: 'cont', label: 'Cont in valuta (4111/401/5124...)', type: 'select', options: TVAL, default: '4111' },
      { name: 'suma', label: 'Diferenta favorabila (lei)', type: 'number', required: true }],
    build: (d) => [L(d.cont || '4111', '765', d.suma, 'Diferență de curs valutar favorabilă')],
  },
  {
    id: 'diferenta_curs_nefavorabila',
    nume: 'Diferenta de curs nefavorabila (pierdere, 665)',
    grup: 'Valuta',
    fields: [F.data, F.partener, F.document,
      { name: 'cont', label: 'Cont in valuta (4111/401/5124...)', type: 'select', options: TVAL, default: '401' },
      { name: 'suma', label: 'Diferenta nefavorabila (lei)', type: 'number', required: true }],
    build: (d) => [L('665', d.cont || '401', d.suma, 'Diferență de curs valutar nefavorabilă')],
  },

  // ───────────────────── PROVIZIOANE (151) ─────────────────────
  {
    id: 'provizion_constituire',
    nume: 'Constituire provizion pentru riscuri si cheltuieli (6812 = 151)',
    grup: 'Provizioane',
    fields: [F.data, F.document, F.explicatie, { name: 'suma', label: 'Suma provizionului', type: 'number', required: true }],
    build: (d) => [L('6812', '151', d.suma, d.explicatie || 'Constituire provizion pentru riscuri si cheltuieli')],
  },
  {
    id: 'provizion_reluare',
    nume: 'Reluare/anulare provizion (151 = 7812)',
    grup: 'Provizioane',
    fields: [F.data, F.document, F.explicatie, { name: 'suma', label: 'Suma reluata', type: 'number', required: true }],
    build: (d) => [L('151', '7812', d.suma, d.explicatie || 'Reluare provizion devenit fara obiect')],
  },

  // ───────────────────── ASOCIATI / DECONTARI INTRAGRUP ─────────────────────
  {
    id: 'imprumut_asociat',
    nume: 'Imprumut primit de la asociat (5xx = 455)',
    grup: 'Asociati / Grup',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasat in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '455', d.suma, 'Împrumut de la asociat (cont curent)')],
  },
  {
    id: 'restituire_asociat',
    nume: 'Restituire imprumut catre asociat (455 = 5xx)',
    grup: 'Asociati / Grup',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L('455', d.cont || '5121', d.suma, 'Restituire împrumut către asociat')],
  },
  {
    id: 'dobanda_asociat',
    nume: 'Dobanda datorata asociatului (666 = 4558/455)',
    grup: 'Asociati / Grup',
    fields: [F.data, F.partener, F.document, { name: 'suma', label: 'Dobanda (lei)', type: 'number', required: true }],
    build: (d) => [L('666', '455', d.suma, 'Dobânda aferentă împrumutului de la asociat')],
  },
  {
    id: 'decontare_intragrup',
    nume: 'Decontare intre unitate si subunitati (481)',
    grup: 'Asociati / Grup',
    fields: [F.data, F.partener, F.document, F.explicatie,
      { name: 'sens', label: 'Sens', type: 'select', options: [{ value: 'creanta', label: 'Creanta (481 debitor)' }, { value: 'datorie', label: 'Datorie (481 creditor)' }], default: 'creanta' },
      { name: 'cont', label: 'Cont corespondent (5121/...)', type: 'account', default: '5121' }, F.suma],
    build: (d) => (d.sens === 'datorie'
      ? [L(d.cont || '5121', '481', d.suma, 'Decontare intragrup - încasare')]
      : [L('481', d.cont || '5121', d.suma, 'Decontare intragrup - plată')]),
  },

  // ───────────────────── DIVIDENDE ─────────────────────
  {
    id: 'repartizare_dividende',
    nume: 'Repartizare profit la dividende (117 = 457) + impozit',
    grup: 'Dividende',
    entitate: 'srl', // PFA nu distribuie dividende — intreprinzatorul isi retrage sumele direct
    fields: [F.data, F.document,
      { name: 'brut', label: 'Dividende brute', type: 'number', required: true },
      { name: 'cota', label: 'Cota impozit dividende (%)', type: 'number', default: fiscal.FISCAL.impozitDividende },
      { name: 'contSursa', label: 'Sursa (117 reportat / 121 curent)', type: 'select', options: [{ value: '117', label: '117 Rezultat reportat' }, { value: '121', label: '121 Profit curent' }], default: '117' }],
    build: (d) => {
      const impozit = round2((Number(d.brut) || 0) * (Number(d.cota) || 0) / 100);
      const lines = [L(d.contSursa || '117', '457', d.brut, 'Repartizare profit la dividende')];
      if (impozit > 0) lines.push(L('457', '446', impozit, 'Impozit pe dividende reținut la sursă'));
      return lines;
    },
  },
  {
    id: 'plata_dividende',
    nume: 'Plata dividende nete (457 = 5xx)',
    grup: 'Dividende',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L('457', d.cont || '5121', d.suma, 'Plata dividende nete')],
  },

  // ───────────────────── SUBVENTII ─────────────────────
  {
    id: 'subventie_exploatare',
    nume: 'Subventie de exploatare - de incasat (445 = 741)',
    grup: 'Subventii',
    fields: [F.data, F.partener, F.document, { name: 'suma', label: 'Suma subventiei', type: 'number', required: true }],
    build: (d) => [L('445', '741', d.suma, 'Subvenție de exploatare cuvenită')],
  },
  {
    id: 'subventie_investitii',
    nume: 'Subventie pentru investitii - de incasat (445 = 475)',
    grup: 'Subventii',
    fields: [F.data, F.partener, F.document, { name: 'suma', label: 'Suma subventiei', type: 'number', required: true }],
    build: (d) => [L('445', '475', d.suma, 'Subvenție pentru investiții (venit în avans)')],
  },
  {
    id: 'incasare_subventie',
    nume: 'Incasare subventie (5xx = 445)',
    grup: 'Subventii',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasat in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '445', d.suma, 'Încasare subvenție')],
  },
  {
    id: 'venit_subventie_investitii',
    nume: 'Recunoastere venit subventie investitii (475 = 7584)',
    grup: 'Subventii',
    fields: [F.data, F.document, { name: 'suma', label: 'Cota-parte (de obicei = amortizarea lunii)', type: 'number', required: true }],
    build: (d) => [L('475', '7584', d.suma, 'Venit din subvenție pentru investiții (eșalonat)')],
  },

  // ───────────────────── CHELTUIELI / VENITURI IN AVANS (471/472) ─────────────────────
  {
    id: 'cheltuiala_in_avans',
    nume: 'Cheltuiala in avans - inregistrare (471 = 401/5xx)',
    grup: 'Regularizari',
    fields: [F.data, F.partener, F.document, F.explicatie,
      { name: 'cont', label: 'Contrapartida', type: 'select', options: [{ value: '401', label: '401 Furnizori' }, { value: '5121', label: '5121 Banca' }, { value: '5311', label: '5311 Casa' }], default: '401' },
      { name: 'suma', label: 'Suma totala platita in avans', type: 'number', required: true }],
    build: (d) => [L('471', d.cont || '401', d.suma, d.explicatie || 'Cheltuiala inregistrata in avans')],
  },
  {
    id: 'recunoastere_cheltuiala_avans',
    nume: 'Recunoastere cheltuiala din avans (6xx = 471)',
    grup: 'Regularizari',
    fields: [F.data, F.document, F.explicatie,
      { name: 'contChelt', label: 'Cont de cheltuiala (6xx)', type: 'account', default: '613' },
      { name: 'suma', label: 'Cota-parte a perioadei', type: 'number', required: true }],
    build: (d) => [L(d.contChelt || '613', '471', d.suma, d.explicatie || 'Cota de cheltuiala din avans')],
  },
  {
    id: 'venit_in_avans',
    nume: 'Venit in avans - inregistrare (4111/5xx = 472)',
    grup: 'Regularizari',
    fields: [F.data, F.partener, F.document, F.explicatie,
      { name: 'cont', label: 'Contrapartida', type: 'select', options: [{ value: '4111', label: '4111 Clienti' }, { value: '5121', label: '5121 Banca' }, { value: '5311', label: '5311 Casa' }], default: '4111' },
      { name: 'suma', label: 'Suma totala incasata in avans', type: 'number', required: true }],
    build: (d) => [L(d.cont || '4111', '472', d.suma, d.explicatie || 'Venit inregistrat in avans')],
  },
  {
    id: 'recunoastere_venit_avans',
    nume: 'Recunoastere venit din avans (472 = 7xx)',
    grup: 'Regularizari',
    fields: [F.data, F.document, F.explicatie,
      { name: 'contVenit', label: 'Cont de venit (7xx)', type: 'account', default: '704' },
      { name: 'suma', label: 'Cota-parte a perioadei', type: 'number', required: true }],
    build: (d) => [L('472', d.contVenit || '704', d.suma, d.explicatie || 'Cota de venit din avans')],
  },

  // ───────────────── EFECTE DE COMERT SI ACREDITIVE ─────────────────
  {
    id: 'efect_primit_client',
    nume: 'Efect de primit de la client (bilet la ordin / cambie acceptata)',
    grup: 'Efecte de comert',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.suma],
    build: (d) => [L('413', '4111', d.suma, 'Acceptare efect de comerț de la client (413 = 4111)')],
  },
  {
    id: 'incasare_efect_client',
    nume: 'Incasare efect de comert la scadenta',
    grup: 'Efecte de comert',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasat in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '413', d.suma, 'Încasare efect de comerț la scadență')],
  },
  {
    id: 'scontare_efect',
    nume: 'Scontare efect la banca (incasare inainte de scadenta)',
    grup: 'Efecte de comert',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'scont', label: 'Taxa de scont + comision bancar (lei)', type: 'number', default: 0 }],
    build: (d) => {
      const net = round2((d.suma || 0) - (d.scont || 0));
      const lines = [];
      if (net > 0) lines.push(L('5121', '413', net, 'Suma netă încasată din scontarea efectului'));
      if (d.scont > 0) lines.push(L('667', '413', d.scont, 'Taxa de scont (cheltuială financiară)'));
      return lines;
    },
  },
  {
    id: 'efect_platit_furnizor',
    nume: 'Efect de platit catre furnizor (bilet la ordin emis / cambie acceptata)',
    grup: 'Efecte de comert',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.suma],
    build: (d) => [L('401', '403', d.suma, 'Acceptare efect de plată către furnizor (401 = 403)')],
  },
  {
    id: 'plata_efect_furnizor',
    nume: 'Plata efect de comert la scadenta',
    grup: 'Efecte de comert',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L('403', d.cont || '5121', d.suma, 'Plata efect de comerț la scadență')],
  },
  {
    id: 'deschidere_acreditiv',
    nume: 'Deschidere acreditiv (blocare fonduri la banca)',
    grup: 'Acreditive',
    fields: [F.data, F.partener, F.document, F.suma],
    build: (d) => [L('541', '5121', d.suma, 'Deschidere acreditiv (541 = 5121)')],
  },
  {
    id: 'plata_din_acreditiv',
    nume: 'Plata furnizor din acreditiv',
    grup: 'Acreditive',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.suma],
    build: (d) => [L('401', '541', d.suma, 'Plata furnizor din acreditiv (401 = 541)')],
  },
  {
    id: 'inchidere_acreditiv',
    nume: 'Inchidere acreditiv (restituire sold neutilizat)',
    grup: 'Acreditive',
    fields: [F.data, F.document, F.suma],
    build: (d) => [L('5121', '541', d.suma, 'Restituire sold acreditiv neutilizat (5121 = 541)')],
  },

];
