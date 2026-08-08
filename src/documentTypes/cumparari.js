'use strict';

// CUMPARARI — vezi index.js pentru contractul tipurilor.

const { L, F } = require('./helpers');
const fiscal = require('../fiscal');
const { round2 } = require('../util');

module.exports = [
  // ─────────────────────────── CUMPARARI ──────────────────────────
  {
    id: 'factura_cumparare_marfuri',
    nume: 'Factura cumparare marfuri',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.proRataMixt],
    build: (d) => {
      const lines = [L('371', '401', d.baza, 'Cumpărare mărfuri (intrare în stoc)')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  {
    id: 'factura_cumparare_materii',
    nume: 'Factura cumparare materii prime/materiale',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.proRataMixt,
      { name: 'contStoc', label: 'Cont stoc', type: 'account', default: '301' }],
    build: (d) => {
      const lines = [L(d.contStoc || '301', '401', d.baza, 'Cumpărare materii/materiale')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  // ── CUT-OFF: bunul/serviciul a sosit, factura NU ─────────────────────────────────────────────
  // Contul 408 era in plan, in bilant si in SAF-T, dar NICIUN tip de document nu-l producea: la
  // inchiderea lunii, utilitatile consumate si facturate ulterior nu aveau unde sa meargă, deci
  // cheltuiala cadea in luna gresita. TVA-ul e NEEXIGIBIL pana la primirea facturii (4428, nu
  // 4426): dreptul de deducere se naste cu factura, nu cu consumul. Perechea `sosire_factura`
  // face regularizarea.
  {
    id: 'factura_nesosita',
    nume: 'Cheltuiala fara factura (cut-off la inchiderea lunii) — 408',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota,
      { name: 'contChelt', label: 'Cont cheltuiala/stoc', type: 'account', default: '628' }],
    build: (d) => {
      const lines = [L(d.contChelt || '628', '408', d.baza, 'Cheltuială aferentă lunii, factură nesosită')];
      if (d.tva > 0) lines.push(L('4428', '408', d.tva, 'TVA neexigibilă (dreptul de deducere se naște cu factura)'));
      return lines;
    },
  },
  {
    id: 'sosire_factura_nesosita',
    nume: 'Sosirea facturii pentru o cheltuiala din 408 (regularizare)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('408', '401', round2((Number(d.baza) || 0) + (Number(d.tva) || 0)), 'Factura sosită — datoria devine certă')];
      if (d.tva > 0) lines.push(L('4426', '4428', d.tva, 'TVA devine deductibilă la primirea facturii'));
      return lines;
    },
  },
  // ── AUTOFACTURA (art. 320) ────────────────────────────────────────────────────────────────
  // Cand cumparatorul e persoana obligata la plata TVA (achizitie intracomunitara, servicii
  // primite din afara, taxare inversa interna) si NU a primit factura furnizorului pana pe 15 a
  // lunii urmatoare faptului generator, are OBLIGATIA sa emita autofactura.
  //
  // Autofactura NU schimba ce se declara, doar documentul care sustine inregistrarea: o achizitie
  // de servicii din UE intra in D390 pe codul S si cand a venit factura, si cand a fost nevoie de
  // autofactura. De aceea `naturaAutofactura` de mai jos duce la aceleasi coduri ca tipurile de
  // document obisnuite — nu la o categorie separata.
  //
  // DIFERENTA fata de `factura_nesosita`, si intreg motivul pentru care tipul asta exista separat:
  // acolo TVA-ul sta in 4428 (NEEXIGIBIL), fiindca dreptul de deducere se naste cu factura. La
  // autofactura, TVA-ul e EXIGIBIL indiferent de factura — exigibilitatea intervine la data de 15
  // a lunii urmatoare, nu la primirea documentului. Inregistrat gresit prin 4428, TVA-ul colectat
  // ar lipsi din decont si din D390, iar operatiunea ar aparea nedeclarata la ANAF exact in
  // situatia in care legea a cerut autofactura tocmai ca sa NU lipseasca.
  //
  // Datoria sta pe 408 (furnizori - facturi nesosite), nu pe 401: factura chiar nu a sosit.
  {
    id: 'autofactura_achizitie',
    nume: 'Autofactura pentru achizitie cu taxare inversa, fara factura de la furnizor (art. 320)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.cota,
      // NATURA operatiunii se cere EXPLICIT si nu are valoare implicita „ghicita": autofactura
      // acopera trei situatii care se declara diferit, iar din conturi nu se poate citi care e
      // (toate trei dau acelasi 4426 = 4427). O implicita pe „intracom" ar fi umplut D390 cu
      // operatiuni interne, o implicita pe „intern" ar fi ascuns achizitii de la ANAF. Amandoua tacut.
      //
      // BUNURI sau SERVICII se cere; UE sau non-UE se DERIVA din prefixul codului de TVA al
      // partenerului (vezi `codDe` din reporting.d390). Motivul separarii: primul lucru chiar nu
      // se poate citi din date, al doilea se poate — iar un camp in plus ar fi doar inca o ocazie
      // de a bifa gresit. Derivarea repara si articolele deja inregistrate, fara migrare.
      { name: 'naturaAutofactura', label: 'Natura operatiunii (decide daca si cum intra in D390)', type: 'select',
        required: true,
        options: [
          { value: 'intracom', label: 'Achizitie intracomunitara de BUNURI (D390, cod A)' },
          { value: 'servicii', label: 'SERVICII primite de la un prestator extern (D390 cod S, daca prestatorul are cod de TVA din UE)' },
          { value: 'intern331', label: 'Taxare inversa interna, art. 331 (nu intra in D390)' },
        ] },
      { name: 'contStoc', label: 'Cont stoc/cheltuiala/imobilizare', type: 'account', default: '371' }, F.proRataMixt],
    build: (d) => {
      const tva = round2((Number(d.baza) * Number(d.cota || fiscal.FISCAL.tvaStandard)) / 100);
      return [
        L(d.contStoc || '371', '408', d.baza, 'Autofactură (art. 320) — factura furnizorului nu a sosit'),
        L('4426', '4427', tva, 'Taxare inversă — TVA exigibilă fără factură (art. 320)'),
      ];
    },
  },
  {
    id: 'sosire_factura_autofactura',
    nume: 'Sosirea facturii pentru o autofactura (regularizare 408 -> 401)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza],
    build: (d) => [L('408', '401', d.baza, 'Factura furnizorului a sosit — datoria devine certă')],
    // FARA nicio linie de TVA, si asta e esential: taxarea inversa a fost DEJA inregistrata pe
    // autofactura (4426 = 4427). Perechea obisnuita `sosire_factura_nesosita` ar adauga aici
    // `4426 = 4428` si ar deduce TVA-ul a doua oara — de aceea regularizarea are tip propriu, nu
    // se refoloseste cea de la facturi nesosite. Doar BAZA trece din 408 in 401.
  },

  {
    id: 'factura_utilitati',
    nume: 'Factura utilitati (energie, apa)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.proRataMixt],
    build: (d) => {
      const lines = [L('605', '401', d.baza, 'Cheltuieli cu energia și apa')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  {
    id: 'factura_servicii_primita',
    nume: 'Factura servicii primita (chirie, telecom, onorarii...)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.auto50, F.proRataMixt,
      { name: 'contChelt', label: 'Cont cheltuiala', type: 'account', default: '628' }],
    build: (d) => {
      const lines = [L(d.contChelt || '628', '401', d.baza, 'Cheltuieli cu servicii primite')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  {
    id: 'factura_combustibil',
    nume: 'Factura/bon combustibil (cu CUI)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.auto50, F.proRataMixt],
    build: (d) => {
      const lines = [L('6022', '401', d.baza, 'Cheltuieli privind combustibilii')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  {
    id: 'factura_imobilizare',
    nume: 'Factura achizitie imobilizare (mijloc fix)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.auto50,
      { name: 'contImob', label: 'Cont imobilizare', type: 'account', default: '2131' }, F.proRataMixt],
    build: (d) => {
      const lines = [L(d.contImob || '2131', '404', d.baza, 'Achiziție imobilizare')];
      if (d.tva > 0) lines.push(L('4426', '404', d.tva, 'TVA deductibilă'));
      return lines;
    },
  },
  {
    id: 'achizitie_intracomunitara',
    nume: 'Achizitie intracomunitara bunuri (taxare inversa)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.cota,
      { name: 'contStoc', label: 'Cont stoc/cheltuiala', type: 'account', default: '371' },
      F.codNC, F.masaNeta, F.naturaTranz, F.conditieLivrare, F.proRataMixt],
    build: (d) => {
      const tva = round2((Number(d.baza) * Number(d.cota || fiscal.FISCAL.tvaStandard)) / 100);
      return [
        L(d.contStoc || '371', '401', d.baza, 'Achiziție intracomunitară (bază)'),
        L('4426', '4427', tva, 'Taxare inversă - TVA deductibilă și colectată'),
      ];
    },
  },
  {
    id: 'livrare_intracomunitara',
    nume: 'Livrare intracomunitara bunuri (scutita)',
    grup: 'Vanzari',
    eFactura: 'da',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza,
      F.codNC, F.masaNeta, F.naturaTranz, F.conditieLivrare],
    build: (d) => [L('4111', '707', d.baza, 'Livrare intracomunitară (scutită cu drept de deducere)')],
  },

  // ── SERVICIILE INTRACOMUNITARE (art. 278 alin. (2)) ───────────────────────────────────────────
  // Perechea pe SERVICII a celor doua tipuri pe bunuri de mai sus. Existau doar cele pe bunuri,
  // desi art. 325 cere in declaratia recapitulativa si serviciile: orice firma care plateste
  // reclama, gazduire sau licente unui prestator din UE are lunar operatiuni de declarat.
  //
  // Diferenta contabila fata de bunuri e ca NU exista cont de stoc: serviciul se duce direct in
  // cheltuiala. Diferenta fiscala e mai importanta si e motivul pentru care sunt tipuri separate,
  // nu un camp pe cele existente: bunurile intra in D390 pe codurile L/A si in Intrastat, iar
  // serviciile pe P/S si NICIODATA in Intrastat (Intrastatul e statistica de bunuri). Un camp
  // „e serviciu?" pe tipul de bunuri ar fi lasat campurile NC8 si masa neta cerute degeaba.
  {
    id: 'prestare_servicii_intracomunitara',
    nume: 'Prestare intracomunitara de servicii (neimpozabila in Romania, taxabila la beneficiar)',
    grup: 'Vanzari',
    eFactura: 'da',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.items],
    // Fara TVA colectat: locul prestarii e la beneficiar (art. 278 alin. (2)), deci operatiunea
    // e neimpozabila in Romania, iar taxa o datoreaza clientul prin taxare inversa. Pe factura se
    // inscrie mentiunea „taxare inversa". NU e o scutire — de aceea nu trece prin randurile de
    // scutite ale decontului, ci prin randul propriu (R3), ca operatiune neimpozabila in RO.
    build: (d) => [L('4111', '704', d.baza, 'Prestare intracomunitară de servicii (taxare inversă la beneficiar)')],
  },
  {
    id: 'achizitie_servicii_intracomunitara',
    nume: 'Achizitie intracomunitara de servicii (taxare inversa, art. 307 alin. (2))',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.cota,
      { name: 'contChelt', label: 'Cont cheltuiala', type: 'account', default: '628' }, F.proRataMixt],
    // Poarta bifa de pro-rata, ca toate achizitiile cu taxare inversa: motorul stie de acum sa puna
    // partea nedeductibila pe contul de cost, cu contrapartida 4427 (taxa colectata ramane intreaga
    // — vezi `tvaPartialInCost` din server.js). Pana atunci, bifa ar fi dezechilibrat articolul.
    build: (d) => {
      const tva = round2((Number(d.baza) * Number(d.cota || fiscal.FISCAL.tvaStandard)) / 100);
      return [
        L(d.contChelt || '628', '401', d.baza, 'Servicii primite din UE (locul prestării la beneficiar)'),
        L('4426', '4427', tva, 'Taxare inversă — art. 307 alin. (2)'),
      ];
    },
  },
  {
    id: 'taxare_inversa_interna_achizitie',
    nume: 'Achizitie cu taxare inversa interna (art. 331 — cereale, lemn, deseuri, constructii...)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.cota, F.codCategorie331,
      { name: 'contStoc', label: 'Cont stoc/cheltuiala/imobilizare', type: 'account', default: '371' }, F.proRataMixt],
    build: (d) => {
      const tva = round2((Number(d.baza) * Number(d.cota || fiscal.FISCAL.tvaStandard)) / 100);
      return [
        L(d.contStoc || '371', '401', d.baza, 'Achiziție cu taxare inversă internă (bază)'),
        L('4426', '4427', tva, 'Taxare inversă internă - TVA deductibilă și colectată'),
      ];
    },
  },
  {
    id: 'taxare_inversa_interna_livrare',
    nume: 'Livrare cu taxare inversa interna (factura emisa fara TVA)',
    grup: 'Vanzari',
    // art. 331 e operatiune INTERNA intre doi platitori romani — B2B pur
    eFactura: 'da',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.codCategorie331,
      { name: 'contVenit', label: 'Cont venit', type: 'account', default: '707' }],
    build: (d) => [L('4111', d.contVenit || '707', d.baza, 'Livrare cu taxare inversă internă (fără TVA - mențiune pe factura)')],
  },
  {
    id: 'reducere_comerciala_acordata',
    nume: 'Reducere comerciala acordata clientului (ulterioara facturarii)',
    grup: 'Vanzari',
    // art. 330: reducerea acordata dupa livrare se documenteaza prin factura
    eFactura: 'da',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('709', '4111', d.baza, 'Reducere comercială acordată')];
      if (d.tva > 0) lines.push(L('4427', '4111', d.tva, 'TVA aferentă reducerii (storno colectată)'));
      return lines;
    },
  },
  {
    id: 'reducere_comerciala_primita',
    nume: 'Reducere comerciala primita de la furnizor (ulterioara facturarii)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('401', '609', d.baza, 'Reducere comercială primită')];
      if (d.tva > 0) lines.push(L('401', '4426', d.tva, 'TVA aferentă reducerii (storno deductibilă)'));
      return lines;
    },
  },
  {
    id: 'scont_acordat',
    nume: 'Scont de decontare acordat (client care plateste in avans)',
    grup: 'Vanzari',
    // scontul de decontare e cheltuiala FINANCIARA (667), nu ajusteaza baza de TVA
    eFactura: 'nu',
    fields: [F.data, F.partener, F.document, F.suma],
    build: (d) => [L('667', '4111', d.suma, 'Scont de decontare acordat')],
  },
  {
    id: 'scont_primit',
    nume: 'Scont de decontare obtinut (plata in avans catre furnizor)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.document, F.suma],
    build: (d) => [L('401', '767', d.suma, 'Scont de decontare obținut')],
  },

];
