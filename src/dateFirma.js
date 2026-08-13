'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  DATELE DE IDENTITATE ALE FIRMEI — ce lipseste, si ce se intampla daca lipseste
//
//  Modulul exista pentru ca „datele firmei sunt completate" era spus in DOUA locuri
//  care nu se potriveau:
//    - checklistul de pornire („Primii pasi") bifa pasul 1 daca firma avea CUI —
//      deci imediat dupa inscriere, cand nu era completat nimic altceva;
//    - controalele de coerenta cereau, in acelasi ecran, codul CAEN.
//  Un utilizator nou vedea pasul taiat cu „gata" si, la doua clicuri distanta, o
//  atentionare ca datele nu sunt bune. Doua definitii ale aceluiasi lucru.
//
//  MIZA NU E COSMETICA, si asta e partea importanta. Generatoarele nu refuza sa
//  produca declaratii cand campul lipseste — pun un INLOCUITOR plauzibil:
//      caen  lipsa -> „0000"   in D300, D394, D112
//      judet lipsa -> „RO-B"   in e-Factura (o firma din Cluj declarata in Bucuresti)
//      adresa/oras -> „-"      in e-Factura
//  Alegerea e corecta pentru generator (un XML incomplet ar fi respins la depunere,
//  iar refuzul de a genera ar bloca o firma care are nevoie de declaratie ACUM), dar
//  inseamna ca lipsa nu se vede nicaieri: iese o declaratie VALIDA si GRESITA. Deci
//  singurul loc unde poate fi prinsa e inainte, in interfata — de aceea lista de mai
//  jos se deriva din inlocuitorii REALI din src/xml.js, nu din ce ni s-ar parea util.
//
//  Consecinta pentru cine adauga un camp: daca pui un `company.X || 'ceva'` intr-un
//  generator, campul X are ce cauta aici. Poarta din test/run.js verifica exact asta.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * INVENTARUL campurilor de firma care primesc un inlocuitor tacit intr-un generator, cu motivul.
 *
 * Lista are doua roluri, si de aceea nu e doar „ce cere checklistul":
 *   - `cerut: true`  — intra in „Completeaza datele firmei": fara ele antetul fiecarei declaratii
 *     si identitatea emitentului din e-Factura pleaca cu valori INVENTATE;
 *   - `cerut: false` — se substituie si ele, dar cu un marcaj vizibil („-") si nu tin de
 *     identitatea firmei, deci n-au ce cauta intr-un checklist de pornire. Sunt aici fiindca
 *     inventarul trebuie sa fie COMPLET: poarta din test/run.js cere ca fiecare
 *     `company.X || '...'` din generatoare sa apara in lista asta. Asa, un camp nou nu poate
 *     intra tacit in declaratii cu o valoare inventata — trebuie macar declarat, cu motiv scris.
 *
 * `doarTva: true` = se cere numai firmelor inregistrate in scopuri de TVA.
 */
const CAMPURI = [
  { camp: 'nume', eticheta: 'Denumirea firmei',
    deCe: 'apare pe facturi și în antetul fiecărei declarații' },
  { camp: 'cui', eticheta: 'CUI',
    deCe: 'identifică firma în toate declarațiile și în e-Factura' },
  { camp: 'caen', eticheta: 'Cod CAEN', inlocuitor: '0000',
    deCe: 'D300, D394 și D112 îl cer; fără el pleacă „0000"' },
  { camp: 'adresa', eticheta: 'Adresa (strada)', inlocuitor: '-',
    deCe: 'adresa emitentului în e-Factura; fără ea pleacă „-”' },
  { camp: 'oras', eticheta: 'Orașul', inlocuitor: '-',
    deCe: 'adresa emitentului în e-Factura; fără el pleacă „-”' },
  { camp: 'judet', eticheta: 'Județul', inlocuitor: 'RO-B',
    deCe: 'e-Factura cere codul județului; fără el pleacă „RO-B” (București)' },
  { camp: 'perioadaTva', eticheta: 'Perioada fiscală TVA', inlocuitor: 'L', doarTva: true,
    deCe: 'decide dacă decontul D300 e lunar sau trimestrial; fără ea se presupune lunar' },

  // ── Se substituie si ele, dar cu un marcaj VIZIBIL, si nu tin de identitate ──────────────
  // Nu intra in checklist: un pas de pornire care cere IBAN-ul si telefonul unei firme care abia
  // s-a inscris ar ramane rosu saptamani, pentru campuri care nu falsifica nimic — „-" se vede
  // de la distanta ca lipsa, spre deosebire de „0000" sau „RO-B", care trec drept date reale.
  { camp: 'banca', eticheta: 'Banca', inlocuitor: '-', cerut: false,
    deCe: 'apare în D300 (atributul `banca`) și pe facturi' },
  { camp: 'iban', eticheta: 'IBAN', inlocuitor: '-', cerut: false,
    deCe: 'contul din D300 — pe el vine restituirea de TVA; apare și în e-Factura' },
  { camp: 'telefon', eticheta: 'Telefon', inlocuitor: '-', cerut: false,
    deCe: 'date de contact în D300 și D394' },
];

/** `true` daca valoarea campului e goala in sensul formularului (gol, spatii, null). */
function gol(v) { return String(v == null ? '' : v).trim() === ''; }

/**
 * Ce date de identitate lipsesc firmei. Functie PURA.
 * @param {Object} company  firma (vederea scoped `v.company`)
 * @param {Object} [profil] profilul fiscal (fiscalProfile.build) — pentru campurile conditionate
 * @returns {Array<{camp, eticheta, deCe, inlocuitor}>} in ordinea din CAMPURI
 */
function lipsa(company, profil) {
  const c = company || {};
  // Fara profil, `tvaPlatitor` se citeste direct de pe firma: modulul trebuie sa poata fi chemat
  // si din locuri care n-au construit profilul (checklistul din dashboard il are, dar nu ne
  // bazam pe asta — o dependinta obligatorie ar fi impins apelantii sa sara peste verificare).
  const platitorTva = profil ? !!profil.tvaPlatitor : !!c.tvaPlatitor;
  return CAMPURI.filter((f) => f.cerut !== false && (f.doarTva ? platitorTva : true) && gol(c[f.camp]));
}

/** Scurtatura pentru checklist si controale: firma are toate datele cerute de iesirile ei. */
function completa(company, profil) { return lipsa(company, profil).length === 0; }

module.exports = { lipsa, completa, CAMPURI };
