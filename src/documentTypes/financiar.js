'use strict';

// VALUTA/DIF. CURS + PROVIZIOANE + ASOCIATI + DIVIDENDE + SUBVENTII + AVANSURI 471/472 + EFECTE/ACREDITIVE — vezi index.js pentru contractul tipurilor.

const { L, F, TROZ, TVAL } = require('./helpers');
const fiscal = require('../fiscal');
const ajust = require('../ajustari'); // harta cont activ -> cont de ajustare (sursa unica)
const { round2 } = require('../util');

module.exports = [
  // ───────────────────── VALUTA / DIFERENTE DE CURS ─────────────────────
  {
    id: 'factura_vanzare_valuta',
    nume: 'Factura vanzare in valuta (export/intracom)',
    grup: 'Valuta',
    // moneda nu schimba natura: si o factura in euro catre un client roman e in perimetru
    eFactura: 'da',
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
    // reevaluare interna a creantei; niciun document nu pleaca la client
    eFactura: 'nu',
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
  // FELUL provizionului se alege EXPLICIT, fiindca decide deductibilitatea: art. 26 alin. (1)
  // lit. b) face deductibile numai provizioanele pentru garantii de buna executie acordate
  // clientilor (1512); restul sunt nedeductibile. Cat timp toate mergeau pe sinteticul „151",
  // regula fiscala nu avea cum sa le deosebeasca si le trata pe toate ca nedeductibile — o firma
  // de constructii platea impozit in plus. Implicit ramane 1518 „Alte provizioane": prudent, adica
  // nedeductibil, deci o alegere neatenta nu produce o deducere nemeritata.
  {
    id: 'provizion_constituire',
    nume: 'Constituire provizion pentru riscuri si cheltuieli (6812 = 151x)',
    grup: 'Provizioane',
    fields: [F.data, F.document, F.explicatie,
      { name: 'contProvizion', label: 'Felul provizionului (contul)', type: 'account', default: '1518', required: true },
      { name: 'suma', label: 'Suma provizionului', type: 'number', required: true }],
    build: (d) => [L('6812', d.contProvizion || '1518', d.suma, d.explicatie || 'Constituire provizion pentru riscuri și cheltuieli')],
  },
  {
    id: 'provizion_reluare',
    nume: 'Reluare/anulare provizion (151x = 7812)',
    grup: 'Provizioane',
    fields: [F.data, F.document, F.explicatie,
      { name: 'contProvizion', label: 'Felul provizionului (contul)', type: 'account', default: '1518', required: true },
      { name: 'suma', label: 'Suma reluata', type: 'number', required: true }],
    build: (d) => [L(d.contProvizion || '1518', '7812', d.suma, d.explicatie || 'Reluare provizion devenit fără obiect')],
  },
  {
    id: 'provizion_garantii_constituire',
    nume: 'Constituire provizion pentru garantii de buna executie (6812 = 1512) — DEDUCTIBIL',
    grup: 'Provizioane',
    fields: [F.data, F.document, F.explicatie, { name: 'suma', label: 'Suma provizionului', type: 'number', required: true }],
    build: (d) => [L('6812', '1512', d.suma, d.explicatie || 'Provizion pentru garanții de bună execuție acordate clienților')],
  },
  {
    id: 'provizion_garantii_reluare',
    nume: 'Reluare provizion de garantii (1512 = 7812) — venit IMPOZABIL',
    grup: 'Provizioane',
    fields: [F.data, F.document, F.explicatie, { name: 'suma', label: 'Suma reluata', type: 'number', required: true }],
    build: (d) => [L('1512', '7812', d.suma, d.explicatie || 'Reluarea provizionului de garanții (perioada de garanție a expirat)')],
  },

  // ───────────────────── AJUSTARI PENTRU CREANTE INCERTE (491) ─────────────────────
  // Lipseau complet, desi TOATE piesele existau: conturile 491, 6814, 7814, 654 si 754 sunt in
  // planul de conturi, `bilant.js` mapeaza 491 pe randurile 031 si 301, iar `client_incert`
  // (4118 = 4111) exista din iulie. Deci se putea RECLASIFICA o creanta ca incerta, dar nu se
  // putea constitui ajustarea pentru ea — adica tocmai pasul care are efect in rezultat si in
  // impozit. Tiparul e cel numit in analiza din 4 august: cont referit de rapoarte, dar
  // neproducibil de niciun tip de document.
  //
  // Cele patru intrari acopera drumul complet al unei creante care se deterioreaza:
  //   constituire  6814 = 491      (cheltuiala, cand pierderea devine PROBABILA)
  //   reluare       491 = 7814     (venit, cand clientul plateste sau riscul dispare)
  //   scoatere      654 = 4118     (+ reluarea ajustarii, cand pierderea devine CERTA)
  //   reactivare   4111 = 754      (debitor considerat pierdut care plateste totusi)
  //
  // DE CE scoaterea produce DOUA linii: pierderea a fost deja recunoscuta la constituirea
  // ajustarii. Fara reluarea simultana, ea s-ar inregistra a doua oara, iar rezultatul ar fi
  // gresit cu valoarea ajustarii. E aceeasi capcana ca la cedarea unui mijloc fix — jumatatea
  // uitata a operatiunii.
  //
  // Regimul FISCAL nu se decide aici: ajustarea e deductibila in limita a 30% cu conditiile de
  // la art. 26 alin. (1) lit. c), iar pierderea din 654 e ca regula nedeductibila (art. 25 alin.
  // (4) lit. h). Motorul de nedeductibile (`src/deductibilitate.js`) le trateaza deja pe cont —
  // 654 integral nedeductibil; la 6814/7814 partea deductibila depinde de baza ELIGIBILA
  // (art. 26 alin. (1) lit. c: peste 270 de zile, negarantata, debitor neafiliat), nu de cont —
  // deci monografia trebuie doar sa foloseasca CONTURILE CORECTE, nu sa repete regula.
  {
    id: 'ajustare_creanta_constituire',
    nume: 'Constituire ajustare pentru deprecierea creantelor (6814 = 491)',
    grup: 'Provizioane',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.explicatie,
      { name: 'suma', label: 'Valoarea ajustarii (cu TVA, cat se apreciaza ca nu se incaseaza)', type: 'number', required: true }],
    build: (d) => [L('6814', '491', d.suma, d.explicatie || 'Ajustare pentru deprecierea creanțelor-clienți')],
  },
  {
    id: 'ajustare_creanta_reluare',
    nume: 'Reluare ajustare creante (491 = 7814) — clientul a platit sau riscul a disparut',
    grup: 'Provizioane',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.explicatie,
      { name: 'suma', label: 'Suma reluata', type: 'number', required: true }],
    build: (d) => [L('491', '7814', d.suma, d.explicatie || 'Reluarea ajustării pentru deprecierea creanțelor')],
  },
  {
    id: 'creanta_scoasa_din_evidenta',
    nume: 'Scoaterea din evidenta a unei creante irecuperabile (654 = 4118)',
    grup: 'Provizioane',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'suma', label: 'Creanta scoasa din evidenta (cu TVA)', type: 'number', required: true },
      { name: 'ajustare', label: 'Ajustare constituita anterior pentru ea (0 daca nu exista)', type: 'number', default: 0 },
      { name: 'contCreanta', label: 'Cont creanta', type: 'select',
        options: [{ value: '4118', label: '4118 Clienți incerți' }, { value: '4111', label: '4111 Clienți' },
          { value: '461', label: '461 Debitori diverși' }], default: '4118' }],
    build: (d) => {
      const lines = [L('654', d.contCreanta || '4118', d.suma, 'Pierdere din creanță irecuperabilă')];
      // A DOUA JUMATATE, cea uitata: ajustarea constituita pentru aceasta creanta se reia in
      // acelasi timp. Fara ea, pierderea intra in rezultat de doua ori.
      if (d.ajustare > 0) lines.push(L('491', '7814', d.ajustare, 'Reluarea ajustării aferente creanței scoase din evidență'));
      return lines;
    },
  },
  // ───────────────── AJUSTARI PENTRU DEPRECIEREA STOCURILOR SI A IMOBILIZARILOR ─────────────────
  // Urmarea contabila a INVENTARIERII: cand valoarea de inventar e sub cea contabila, minusul se
  // inregistreaza ca ajustare, nu se scoate din cont — valoarea de intrare ramane neatinsa si
  // ajustarea se poate relua. Lipseau complet, desi bilantul le scadea deja pe prefix.
  //
  // Contul de ajustare NU se cere de la utilizator: se DERIVA din contul activului
  // (`ajustari.pentruCont`), acelasi loc din care il ia si propunerea din registrul-inventar.
  // Doua liste ar drifta, iar o alegere gresita ar muta deprecierea pe alt rand de bilant.
  {
    id: 'ajustare_stoc_constituire',
    nume: 'Constituire ajustare pentru deprecierea stocurilor (6814 = 39x)',
    grup: 'Provizioane',
    fields: [F.data, F.document, F.explicatie,
      { name: 'contStoc', label: 'Cont stoc depreciat', type: 'account', default: '371', required: true },
      { name: 'suma', label: 'Deprecierea (valoare contabila - valoare de inventar)', type: 'number', required: true }],
    build: (d) => ajust.linii(d.contStoc || '371', Math.abs(Number(d.suma) || 0)),
  },
  {
    id: 'ajustare_stoc_reluare',
    nume: 'Reluare ajustare stocuri (39x = 7814) — deprecierea a disparut sau stocul a iesit',
    grup: 'Provizioane',
    fields: [F.data, F.document, F.explicatie,
      { name: 'contStoc', label: 'Cont stoc', type: 'account', default: '371', required: true },
      { name: 'suma', label: 'Suma reluata', type: 'number', required: true }],
    build: (d) => ajust.linii(d.contStoc || '371', -Math.abs(Number(d.suma) || 0)),
  },
  {
    id: 'ajustare_imobilizare_constituire',
    nume: 'Constituire ajustare pentru deprecierea imobilizarilor (6813 = 29x)',
    grup: 'Provizioane',
    fields: [F.data, F.document, F.explicatie,
      { name: 'contImob', label: 'Cont imobilizare depreciata', type: 'account', default: '2131', required: true },
      { name: 'suma', label: 'Deprecierea (valoare contabila - valoare de inventar)', type: 'number', required: true }],
    build: (d) => ajust.linii(d.contImob || '2131', Math.abs(Number(d.suma) || 0)),
  },
  {
    id: 'ajustare_imobilizare_reluare',
    nume: 'Reluare ajustare imobilizari (29x = 7813)',
    grup: 'Provizioane',
    fields: [F.data, F.document, F.explicatie,
      { name: 'contImob', label: 'Cont imobilizare', type: 'account', default: '2131', required: true },
      { name: 'suma', label: 'Suma reluata', type: 'number', required: true }],
    build: (d) => ajust.linii(d.contImob || '2131', -Math.abs(Number(d.suma) || 0)),
  },
  {
    id: 'creanta_reactivata',
    nume: 'Creanta reactivata — un debitor considerat pierdut plateste (4111 = 754)',
    grup: 'Provizioane',
    // Are semnatura contabila a unei facturi catre client (411x debitat, cont de clasa 7
    // creditat), deci poarta structurala din test/run.js cere un raspuns explicit. Raspunsul e
    // NU: nu se emite niciun document catre client. Creanta fusese deja facturata odata, cand
    // s-a nascut; aici doar se readuce in evidenta o valoare scoasa anterior, pe baza unei note
    // interne. O a doua factura ar dubla venitul si TVA-ul colectat.
    eFactura: 'nu',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'suma', label: 'Suma reactivata', type: 'number', required: true },
      { name: 'contCreanta', label: 'Cont creanta', type: 'select',
        options: [{ value: '4111', label: '4111 Clienți' }, { value: '461', label: '461 Debitori diverși' }], default: '4111' }],
    // Doar REACTIVAREA creantei; incasarea propriu-zisa se inregistreaza separat, cu extrasul
    // sau chitanta (tipul „Incasare de la client"). Doua documente, doua operatiuni.
    build: (d) => [L(d.contCreanta || '4111', '754', d.suma, 'Creanță reactivată (debitor considerat pierdut)')],
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

  // ───────────────────── CAPITAL SOCIAL ─────────────────────
  // Lipsea complet: nici contul 1011 (capital subscris NEvarsat), nici 456 (decontari cu
  // asociatii privind capitalul) nu existau in plan, desi `bilant.js` mapa deja 1011 pe randul
  // 031. Constituirea unei firme si orice majorare de capital erau deci neinregistrabile.
  // Cele doua momente sunt distincte si trebuie sa ramana asa: SUBSCRIEREA e o promisiune
  // (creanta fata de asociat), VARSAREA e incasarea ei.
  {
    id: 'subscriere_capital',
    nume: 'Subscriere capital social (angajamentul asociatilor) — 456 = 1011',
    grup: 'Capital social',
    entitate: 'srl',
    fields: [F.data, F.document,
      { name: 'suma', label: 'Capital subscris (lei)', type: 'number', required: true }],
    build: (d) => [L('456', '1011', d.suma, 'Capital social subscris de asociați (nevărsat)')],
  },
  {
    id: 'varsare_capital',
    nume: 'Varsarea capitalului subscris (aport in bani)',
    grup: 'Capital social',
    entitate: 'srl',
    fields: [F.data, F.document,
      { name: 'suma', label: 'Suma varsata (lei)', type: 'number', required: true },
      { name: 'cont', label: 'Incasat in', type: 'select', options: TROZ, default: '5121' }],
    // Doua linii, amandoua necesare: incasarea stinge creanta fata de asociat, iar capitalul trece
    // din „subscris nevarsat" in „subscris varsat". Fara a doua, 1011 ramane in bilant la
    // nesfarsit si capitalul varsat apare zero.
    build: (d) => [
      L(d.cont || '5121', '456', d.suma, 'Aport în bani la capitalul social'),
      L('1011', '1012', d.suma, 'Capitalul subscris devine vărsat'),
    ],
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
