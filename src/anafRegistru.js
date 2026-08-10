'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  REGISTRUL PUBLIC AL CONTRIBUABILILOR (ANAF) — verificarea partenerilor
//
//  De ce conteaza contabil, nu doar ca sa se completeze denumirea:
//    - INACTIV (art. 11 Cod fiscal): cheltuielile facute cu un contribuabil declarat inactiv
//      NU sunt deductibile, iar TVA-ul de pe facturile lui NU se deduce. E singura verificare
//      din aplicatie care poate schimba un rezultat fiscal pe baza unei date pe care firma nu
//      o are cum sa o stie din propriile documente;
//    - TVA LA INCASARE la FURNIZOR: daca furnizorul aplica sistemul, dreptul de deducere al
//      cumparatorului se amana pana la PLATA facturii (art. 297 alin. (2)). Aplicatia stia doar
//      daca firma PROPRIE e la incasare (`company.tvaLaIncasare`), deci jumatate din regula;
//    - neinregistrat in scopuri de TVA: o factura de la el nu poate purta TVA deductibila;
//    - RO e-Factura: spune daca partenerul e inregistrat in registrul optional.
//
//  Serviciul e PUBLIC (fara certificat, fara OAuth) si accepta pana la 500 de CUI-uri pe apel,
//  cu maximum o cerere pe secunda. De aceea batch-urile pleaca SECVENTIAL, cu pauza intre ele:
//  o verificare de nomenclator la 3.000 de parteneri e un job de cateva secunde, nu 3.000 de
//  apeluri.
//
//  Forma raspunsului NU e ghicita — e ridicata prin sondare directa a serviciului (vezi
//  docs/api.md). Doua lucruri confirmate acolo si care conteaza in cod:
//    1. plicul e `{ found: [...], notFound: [cui, ...] }` — FARA campurile `cod`/`message` pe
//       care le au alte endpoint-uri ANAF, deci nu te poti baza pe ele ca sa detectezi succesul;
//    2. la cerere malformata serviciul intoarce **HTML** cu status 200 („Request Rejected"),
//       nu JSON — un `JSON.parse` direct ar arunca o eroare de sintaxa fara nicio legatura cu
//       cauza. De aceea raspunsul se verifica INAINTE de a fi parsat.
// ─────────────────────────────────────────────────────────────────────────────

const { anafFetch } = require('./anaf');
const log = require('./log');

const URL_REGISTRU = process.env.CONTAB_ANAF_REGISTRU_URL
  || 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva';

const MAX_LOT = 500;        // limita serviciului pe apel
const PAUZA_MS = 1100;      // limita e 1 cerere/secunda; marja mica peste ea

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CUI numeric, fara prefixul RO si fara separatori. Intoarce `null` daca nu ramane un numar. */
function cuiNumeric(cui) {
  const cifre = String(cui == null ? '' : cui).replace(/^ro/i, '').replace(/[^0-9]/g, '');
  if (!cifre) return null;
  const n = Number(cifre);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Data ceruta de serviciu (YYYY-MM-DD). Registrul raspunde „la data asta", deci verificarea
 *  unei facturi vechi se poate face pe data FACTURII, nu pe cea de azi. */
function ziua(data) {
  const s = String(data || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10);
}

/**
 * Reduce raspunsul stufos al ANAF (7 sectiuni, ~60 de campuri) la ce foloseste contabilitatea.
 * Campurile se citesc DEFENSIV: sectiunile lipsa dau `{}`, nu exceptie — serviciul le omite
 * pentru unele forme de organizare, iar o verificare de nomenclator nu are voie sa cada pentru
 * ca un partener n-are sediu social completat.
 */
function normalizeaza(gasit) {
  const g = (gasit && gasit.date_generale) || {};
  const tva = (gasit && gasit.inregistrare_scop_Tva) || {};
  const inc = (gasit && gasit.inregistrare_RTVAI) || {};
  const inact = (gasit && gasit.stare_inactiv) || {};
  const split = (gasit && gasit.inregistrare_SplitTVA) || {};
  const sediu = (gasit && gasit.adresa_sediu_social) || {};
  const stare = String(g.stare_inregistrare || '');
  // Perioada de TVA curenta = ultima din lista (serviciul le da cronologic). Mesajul ei explica
  // ANULAREA codului, iar asta e exact ce vrea sa citeasca un contabil cand vede „nu e platitor".
  const perioade = Array.isArray(tva.perioade_TVA) ? tva.perioade_TVA : [];
  const ultima = perioade.length ? perioade[perioade.length - 1] : {};
  return {
    cui: String(g.cui == null ? '' : g.cui),
    denumire: String(g.denumire || ''),
    adresa: String(g.adresa || ''),
    nrRegCom: String(g.nrRegCom || ''),
    caen: String(g.cod_CAEN || ''),
    judet: String(sediu.scod_JudetAuto || ''),
    localitate: String(sediu.sdenumire_Localitate || ''),
    stareInregistrare: stare,
    // RADIERE nu e acelasi lucru cu INACTIV si nu vine pe acelasi camp: radierea se citeste din
    // textul starii (sau din data de radiere), inactivarea din sectiunea ei.
    radiat: /radiere/i.test(stare) || !!String(inact.dataRadiere || '').trim(),
    inactiv: !!inact.statusInactivi,
    dataInactivare: String(inact.dataInactivare || ''),
    dataReactivare: String(inact.dataReactivare || ''),
    tvaPlatitor: !!tva.scpTVA,
    tvaDeLa: String(ultima.data_inceput_ScpTVA || ''),
    tvaPanaLa: String(ultima.data_sfarsit_ScpTVA || ''),
    tvaMotivAnulare: String(ultima.mesaj_ScpTVA || ''),
    tvaLaIncasare: !!inc.statusTvaIncasare,
    tvaIncasareDeLa: String(inc.dataInceputTvaInc || ''),
    splitTva: !!split.statusSplitTVA,
    eFactura: !!g.statusRO_e_Factura,
  };
}

/** Raspunsul serviciului, verificat INAINTE de parsare (vezi antet: erorile vin ca HTML/200). */
async function citesteRaspuns(r) {
  const text = await r.text();
  const inceput = text.slice(0, 200).trim();
  if (!r.ok) throw new Error('Registrul ANAF a raspuns ' + r.status + ': ' + inceput);
  if (!/^[[{]/.test(inceput)) {
    throw new Error('Registrul ANAF a raspuns altceva decat JSON (cerere respinsa sau serviciu '
      + 'indisponibil): ' + inceput.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160));
  }
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('Raspuns ANAF neparsabil: ' + e.message, { cause: e }); }
  if (!j || !Array.isArray(j.found)) throw new Error('Raspuns ANAF fara lista `found`.');
  return j;
}

/**
 * Verifica o lista de CUI-uri in registrul public.
 * @param {Array<string|number>} cuiuri
 * @param {string} [data] YYYY-MM-DD — starea LA acea data (implicit azi)
 * @returns {Promise<{ gasiti: Object, negasite: string[], interogate: number, loturi: number }>}
 *   `gasiti` = harta cui (sir, fara RO) -> inregistrarea normalizata.
 */
async function verifica(cuiuri, data) {
  const zi = ziua(data);
  // deduplicare + normalizare: aceeasi firma poate aparea de doua ori in nomenclator (cu si
  // fara prefixul RO), iar serviciul are un plafon de 500 pe apel — nu-l irosim pe duplicate.
  const numere = [];
  const vazute = new Set();
  for (const c of cuiuri || []) {
    const n = cuiNumeric(c);
    if (n == null || vazute.has(n)) continue;
    vazute.add(n); numere.push(n);
  }
  const gasiti = {};
  const negasite = [];
  let loturi = 0;
  for (let i = 0; i < numere.length; i += MAX_LOT) {
    const lot = numere.slice(i, i + MAX_LOT);
    if (loturi) await sleep(PAUZA_MS); // plafonul serviciului: o cerere pe secunda
    loturi += 1;
    const r = await anafFetch('Registru ANAF', URL_REGISTRU, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lot.map((cui) => ({ cui, data: zi }))),
    }, true); // idempotent (o CITIRE, chiar daca e POST) — deci se poate reincerca
    const j = await citesteRaspuns(r);
    for (const f of j.found) {
      const n = normalizeaza(f);
      if (n.cui) gasiti[n.cui] = n;
    }
    for (const c of (j.notFound || [])) negasite.push(String(c));
  }
  log.info('Registru ANAF: ' + numere.length + ' CUI-uri verificate', { loturi, gasite: Object.keys(gasiti).length, negasite: negasite.length });
  return { gasiti, negasite, interogate: numere.length, loturi };
}

module.exports = { verifica, normalizeaza, cuiNumeric, ziua, citesteRaspuns, URL_REGISTRU, MAX_LOT };
