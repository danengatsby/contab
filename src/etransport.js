'use strict';

// RO e-Transport (Sistemul de monitorizare a transporturilor de bunuri) — OUG 41/2022.
// Genereaza declaratia XML pentru obtinerea codului UIT inainte de punerea in miscare a
// marfii. Modul PUR (fara stare, fara retea): asambleaza declaratia din articolul contabil
// (de regula un aviz de insotire) + datele de transport furnizate la depunere (vehicul,
// traseu, organizator) si o serializeaza. Trimiterea la ANAF si stocarea UIT stau in
// src/etransportService.js; endpoint-urile API in src/anaf.js (uploadEtransport/etransportStatus).
//
// Schema urmata: eTransport v2 (namespace mfp:anaf:dgti:eTransport:declaratie:v2). Ca la
// celelalte declaratii, validarea de aici prinde erorile frecvente (bine-format + campuri
// obligatorii); validarea OFICIALA ramane fata de XSD-ul ANAF inainte de depunere.

const { round2 } = require('./util');
const { umCode } = require('./xml'); // acelasi nomenclator UN/ECE ca la e-Factura (codUnitateMasura)

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const num2 = (x) => (Number(x) || 0).toFixed(2);
const cui0 = (cui) => String(cui || '').replace(/^ro/i, '').replace(/\s/g, '');

// ───────────────────────── Nomenclatoare oficiale ─────────────────────────

// Tipul operatiunii (codTipOperatiune) — cine misca marfa si pe ce ruta.
// Valorile si denumirile sunt cele din documentatia XSD-ului oficial (CodTipOperatiuneType).
const TIP_OPERATIUNE = {
  10: 'AIC - Achizitie intracomunitara',
  12: 'LHI - Operatiuni in sistem lohn (UE) - intrare',
  14: 'SCI - Stocuri la dispozitia clientului (Call-off stock) - intrare',
  20: 'LIC - Livrare intracomunitara',
  22: 'LHE - Operatiuni in sistem lohn (UE) - iesire',
  24: 'SCE - Stocuri la dispozitia clientului (Call-off stock) - iesire',
  30: 'TTN - Transport pe teritoriul national',
  40: 'IMP - Import',
  50: 'EXP - Export',
  60: 'DIN - Tranzactie intracomunitara - Intrare pentru depozitare/formare nou transport',
  70: 'DIE - Tranzactie intracomunitara - Iesire dupa depozitare/formare nou transport',
};
// Scopul operatiunii (codScopOperatiune) — de ce se misca marfa (CodScopOperatiuneType).
const SCOP_OPERATIUNE = {
  101: 'Comercializare',
  201: 'Productie',
  301: 'Gratuitati',
  401: 'Echipament comercial',
  501: 'Mijloace fixe',
  601: 'Consum propriu',
  703: 'Operatiuni de livrare cu instalare',
  704: 'Transfer intre gestiuni',
  705: 'Bunuri puse la dispozitia clientului',
  801: 'Leasing financiar/operational',
  802: 'Bunuri in garantie',
  901: 'Operatiuni scutite',
  1001: 'Investitie in curs',
  1101: 'Donatii, ajutoare',
  9901: 'Altele',
  9999: 'Acelasi cu operatiunea',
};
// Scopurile ADMISE per tip de operatiune (documentatia XSD). La tipurile de tranzit / lohn /
// call-off / import / export scopul e mereu „9999 - acelasi cu operatiunea".
const SCOP_ADMIS = {
  10: [101, 201, 301, 401, 501, 601, 703, 801, 802, 901, 1001, 1101, 9901],
  20: [101, 301, 703, 801, 802, 9901],
  30: [101, 704, 705, 9901],
  12: [9999], 14: [9999], 22: [9999], 24: [9999], 40: [9999], 50: [9999], 60: [9999], 70: [9999],
};
// Tipul documentului de transport (tipDocument).
const TIP_DOCUMENT = { 10: 'CMR', 20: 'Factura', 30: 'Aviz de insotire a marfii', 9999: 'Altele' };

// Codurile de judet (codJudet) — SIRUTA, 2 cifre. Cheie: nume normalizat (fara diacritice,
// litere mici). Se accepta si codul direct (2 cifre) in datele de transport.
const JUDETE = {
  alba: '01', arad: '02', arges: '03', bacau: '04', bihor: '05', 'bistrita-nasaud': '06',
  botosani: '07', brasov: '08', braila: '09', buzau: '10', 'caras-severin': '11', cluj: '12',
  constanta: '13', covasna: '14', dambovita: '15', dolj: '16', galati: '17', gorj: '18',
  harghita: '19', hunedoara: '20', ialomita: '21', iasi: '22', ilfov: '23', maramures: '24',
  mehedinti: '25', mures: '26', neamt: '27', olt: '28', prahova: '29', 'satu mare': '30',
  salaj: '31', sibiu: '32', suceava: '33', teleorman: '34', timis: '35', tulcea: '36',
  vaslui: '37', valcea: '38', vrancea: '39', bucuresti: '40', calarasi: '51', giurgiu: '52',
};
// Codurile ISO 3166-2 de judet (RO-XX) \u2014 asa e stocat judetul firmei in setari (format e-Factura).
// Cheie: sufixul (fara \u201eRO-"), 1-2 litere; valoare: acelasi cod SIRUTA de 2 cifre.
const JUDETE_ISO = {
  AB: '01', AR: '02', AG: '03', BC: '04', BH: '05', BN: '06', BT: '07', BV: '08', BR: '09', BZ: '10',
  CS: '11', CJ: '12', CT: '13', CV: '14', DB: '15', DJ: '16', GL: '17', GJ: '18', HR: '19', HD: '20',
  IL: '21', IS: '22', IF: '23', MM: '24', MH: '25', MS: '26', NT: '27', OT: '28', PH: '29', SM: '30',
  SJ: '31', SB: '32', SV: '33', TR: '34', TM: '35', TL: '36', VS: '37', VL: '38', VN: '39', B: '40',
  CL: '51', GR: '52',
};
function judetCod(j) {
  const s = String(j || '').trim();
  if (/^\d{1,2}$/.test(s)) return s.padStart(2, '0'); // cod direct SIRUTA
  const iso = s.toUpperCase().replace(/^RO[-\s]?/, ''); // \u201eRO-CJ" / \u201eRO-B" / \u201eCJ"
  if (JUDETE_ISO[iso]) return JUDETE_ISO[iso];
  const key = s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // scoate diacriticele (combinari NFD)
    .replace(/\bjud(et)?\.?\s*/i, '').replace(/\s+/g, ' ').trim();
  return JUDETE[key] || '';
}

// Tipul operatiunii dedus din tipul articolului contabil (ajustabil manual la depunere).
function defaultTipOperatiune(tip) {
  if (tip === 'livrare_intracomunitara') return 20;
  if (tip === 'achizitie_intracomunitara') return 10;
  if (tip === 'import_vamal') return 40;
  return 30; // transport intern (aviz, vanzare interna)
}

// Articolele pe care are sens sa se ceara UIT: miscari de bunuri (nu servicii/trezorerie).
const ELIGIBLE_TYPES = new Set([
  'aviz_livrare', 'livrare_intracomunitara', 'achizitie_intracomunitara', 'import_vamal',
  'factura_vanzare_marfuri', 'factura_vanzare_produse',
]);
function isEtransportEligible(entry) {
  return !!entry && ELIGIBLE_TYPES.has(entry.tip);
}

// ───────────────────────── Asamblarea declaratiei ─────────────────────────

/** Valoarea fara TVA a marfii transportate: din linii (items) daca exista, altfel din
 *  liniile contabile de venit (avizul: 418 = 707 pe baza). */
function valoareFaraTva(entry) {
  const items = Array.isArray(entry.items) ? entry.items : [];
  if (items.length) return round2(items.reduce((s, it) => s + (Number(it.cantitate) || 0) * (Number(it.pret) || 0), 0));
  const REVENUE = new Set(['701', '702', '703', '704', '707', '708']);
  let v = 0;
  for (const l of entry.lines || []) if (REVENUE.has(l.credit)) v = round2(v + (Number(l.suma) || 0));
  return v;
}

function mapGood(g, nrCrt, td) {
  return {
    // nrCrt e DOAR pentru ordonare interna / interfata: schema oficiala NU are un asemenea
    // atribut pe bunuriTransportate, deci nu se serializeaza (ar invalida declaratia).
    nrCrt,
    codScopOperatiune: String(g.codScop || td.codScopOperatiune || '101'),
    codTarifar: String(g.codTarifar || '').replace(/\s/g, ''),
    denumireMarfa: String(g.denumire || g.nume || 'Marfa').slice(0, 200), // Str200
    cantitate: round2(g.cantitate),
    codUnitateMasura: umCode(g.um),
    greutateNeta: round2(g.greutateNeta),
    greutateBruta: round2(g.greutateBruta != null ? g.greutateBruta : g.greutateNeta),
    valoareLeiFaraTva: round2(g.valoare),
  };
}

/** Bunurile transportate: `td.bunuri` (per pozitie, pentru transporturi multi-NC) BATE
 *  derivarea din aviz; altfel o singura pozitie agregata din articol. */
function buildGoods(entry, td) {
  if (Array.isArray(td.bunuri) && td.bunuri.length) {
    return td.bunuri.map((g, i) => mapGood(g, i + 1, td));
  }
  const items = Array.isArray(entry.items) ? entry.items : [];
  const cant = items.reduce((s, it) => s + (Number(it.cantitate) || 0), 0) || 1;
  const um = (items[0] && items[0].um) || 'buc';
  const denum = items.length === 1 ? items[0].nume
    : ('Marfuri conform ' + (entry.tipNume || 'aviz') + (entry.document ? ' ' + entry.document : ''));
  return [mapGood({
    denumire: td.denumireMarfa || denum,
    codScop: td.codScopOperatiune,
    codTarifar: td.codTarifar || (entry.intrastat && entry.intrastat.codNC) || '',
    cantitate: cant, um,
    greutateNeta: td.greutateNeta,
    greutateBruta: td.greutateBruta != null ? td.greutateBruta : td.greutateNeta,
    valoare: valoareFaraTva(entry),
  }, 1, td)];
}

// codPtf (1..38) si codBirouVamal sunt NUMERICE in schema (xs:int cu enumerare), nu etichete
// de tipul „NADLAC2" — pastram doar cifrele, ca o eticheta gresita sa nu ajunga in XML.
const codNumeric = (v) => (/^\d+$/.test(String(v || '').trim()) ? String(v).trim() : '');

function buildLoc(loc) {
  loc = loc || {};
  return {
    codBirouVamal: codNumeric(loc.codBirouVamal),
    codPtf: codNumeric(loc.codPtf), // punct de trecere a frontierei
    codJudet: judetCod(loc.judet || loc.codJudet),
    denumireLocalitate: String(loc.localitate || loc.denumireLocalitate || '').trim().slice(0, 100),
    denumireStrada: String(loc.strada || loc.denumireStrada || '').trim().slice(0, 100),
    numar: String(loc.numar || '').trim().slice(0, 20),
    codPostal: String(loc.codPostal || '').trim().slice(0, 20),
    alteInfo: String(loc.alteInfo || '').slice(0, 200),
  };
}

/**
 * Asambleaza declaratia e-Transport din articol + datele de transport furnizate la depunere.
 * @param {object} company firma (cui, nume, adresa, oras, judet)
 * @param {object} entry articolul contabil (de regula aviz_livrare)
 * @param {object} td date transport: { codTipOperatiune?, codScopOperatiune, nrVehicul,
 *   nrRemorca1?, nrRemorca2?, organizator?{cui,nume,tara}, partenerTara?, dataTransport?,
 *   codTarifar?, greutateNeta?, greutateBruta?, bunuri?[], start?{}, final?{}, document?{} }
 */
function buildDeclaration(company, entry, td) {
  td = td || {};
  const codTip = Number(td.codTipOperatiune) || defaultTipOperatiune(entry.tip);
  const org = td.organizator || {};
  const orgCui = cui0(org.cui || company.cui);
  return {
    codDeclarant: cui0(company.cui),
    refDeclarant: String(td.refDeclarant || entry.document || ('aviz-' + entry.id)).slice(0, 50),
    codTipOperatiune: codTip,
    bunuri: buildGoods(entry, td),
    partener: {
      codTara: String(td.partenerTara || 'RO').toUpperCase().slice(0, 2),
      cod: cui0(entry.partenerCui).slice(0, 30),      // Cod30Type
      denumire: String(entry.partener || '').slice(0, 200), // Str200
    },
    transport: {
      codTaraOrgTransport: String(org.tara || 'RO').toUpperCase().slice(0, 2),
      codOrgTransport: orgCui.slice(0, 30),
      denumireOrgTransport: String(org.nume || company.nume || '').slice(0, 200),
      nrVehicul: String(td.nrVehicul || '').toUpperCase().replace(/\s/g, '').slice(0, 20),
      nrRemorca1: String(td.nrRemorca1 || '').toUpperCase().replace(/\s/g, '').slice(0, 20),
      nrRemorca2: String(td.nrRemorca2 || '').toUpperCase().replace(/\s/g, '').slice(0, 20),
      dataTransport: /^\d{4}-\d{2}-\d{2}$/.test(String(td.dataTransport || '')) ? td.dataTransport : (entry.data || new Date().toISOString().slice(0, 10)),
    },
    // pentru transport intern implicit plecarea e din sediul firmei, sosirea la partener
    start: buildLoc(td.start || { judet: company.judet, localitate: company.oras, strada: company.adresa }),
    final: buildLoc(td.final),
    document: {
      tipDocument: String((td.document && td.document.tip) || (entry.tip === 'aviz_livrare' ? '30' : '20')),
      numarDocument: String((td.document && td.document.numar) || entry.document || '').slice(0, 50),
      dataDocument: (td.document && /^\d{4}-\d{2}-\d{2}$/.test(String(td.document.data)) ? td.document.data : (entry.data || '')),
      observatii: String((td.document && td.document.observatii) || '').slice(0, 200),
    },
  };
}

// ───────────────────────── Validare pre-depunere ─────────────────────────

// Operatiuni la care marfa INTRA in tara (punctul de plecare al traseului intern e o frontiera:
// birou vamal la import, punct de trecere a frontierei la achizitie/lohn/call-off/tranzit).
const INTRA_IN = new Set([10, 12, 14, 40, 60]);
// Operatiuni la care marfa IESE din tara (punctul de sosire e o frontiera).
const INTRA_OUT = new Set([20, 22, 24, 50, 70]);

/** @returns { ok, errors:[], warnings:[] } — erori = depunere respinsa; avertismente = de verificat.
 *  Prinde constrangerile pe care le impune si XSD-ul oficial (campuri obligatorii, enum-uri,
 *  formate) inainte de depunere; validarea OFICIALA fata de XSD ramane scripts/valideaza-etransport.sh. */
function validate(decl) {
  const errors = []; const warnings = [];
  if (!decl.codDeclarant) errors.push('Lipseste CUI-ul declarantului (firma).');
  else if (!/^\d{2,10}$/.test(decl.codDeclarant)) warnings.push('CUI-ul declarantului „' + decl.codDeclarant + '" nu pare valid (asteptam 2-10 cifre).');
  const tip = Number(decl.codTipOperatiune);
  if (!TIP_OPERATIUNE[tip]) errors.push('Tip de operatiune necunoscut: ' + decl.codTipOperatiune + '.');
  if (!decl.transport.nrVehicul) errors.push('Lipseste numarul de inmatriculare al vehiculului.');
  if (!decl.bunuri.length) errors.push('Nicio marfa de transportat.');
  const admis = SCOP_ADMIS[tip];
  for (const g of decl.bunuri) {
    if (!SCOP_OPERATIUNE[g.codScopOperatiune]) warnings.push('Scop de operatiune necunoscut la „' + g.denumireMarfa + '": ' + g.codScopOperatiune + '.');
    else if (admis && !admis.includes(Number(g.codScopOperatiune))) {
      // regula din documentatia XSD: scopurile admise depind de tipul operatiunii
      warnings.push('Scopul ' + g.codScopOperatiune + ' nu e admis la „' + TIP_OPERATIUNE[tip] + '" (admise: ' + admis.join(', ') + ').');
    }
    if (!g.denumireMarfa) errors.push('Lipseste denumirea marfii la o pozitie.');
    if (!g.codTarifar) errors.push('Lipseste codul tarifar (NC) la „' + g.denumireMarfa + '".');
    // schema: pattern [0-9]{4}|[0-9]{6}|[0-9]{8} — 5 sau 7 cifre sunt RESPINSE, nu tolerate
    else if (!/^(\d{4}|\d{6}|\d{8})$/.test(g.codTarifar)) errors.push('Codul tarifar „' + g.codTarifar + '" e invalid (schema cere exact 4, 6 sau 8 cifre).');
    if (!(g.cantitate > 0)) errors.push('Cantitate 0 la „' + g.denumireMarfa + '".');
    if (!(g.greutateBruta > 0)) errors.push('Lipseste greutatea bruta (kg) la „' + g.denumireMarfa + '".');
    else if (g.greutateNeta > g.greutateBruta) warnings.push('Greutatea neta o depaseste pe cea bruta la „' + g.denumireMarfa + '".');
    if (!(g.valoareLeiFaraTva > 0)) warnings.push('Valoare 0 (fara TVA) la „' + g.denumireMarfa + '".');
  }
  if (!TIP_DOCUMENT[decl.document.tipDocument]) warnings.push('Tip de document de transport necunoscut: ' + decl.document.tipDocument + '.');
  if (!decl.document.dataDocument) errors.push('Lipseste data documentului de transport.');
  if (!decl.transport.dataTransport) errors.push('Lipseste data transportului.');
  if (!decl.transport.denumireOrgTransport) errors.push('Lipseste denumirea organizatorului de transport.');
  // traseul rutier: fiecare capat e ori o frontiera (PTF / birou vamal, coduri NUMERICE), ori o
  // adresa interna completa — in schema, <locatie> cere judet + localitate + STRADA, toate trei.
  const isBorder = (l) => !!(l.codBirouVamal || l.codPtf);
  const adresaOk = (l) => !!(l.codJudet && l.denumireLocalitate && l.denumireStrada);
  const locErr = (l, care) => {
    if (isBorder(l) || adresaOk(l)) return;
    if (l.codJudet && l.denumireLocalitate && !l.denumireStrada) errors.push('Lipseste strada la locul de ' + care + ' (schema o cere impreuna cu judetul si localitatea).');
    else errors.push('Locul de ' + care + ' incomplet: fie judet + localitate + strada, fie codul NUMERIC de birou vamal / punct de trecere a frontierei (ex. 4 = Nadlac, nu „NADLAC").');
  };
  locErr(decl.start, 'plecare');
  locErr(decl.final, 'sosire');
  // coerenta traseu <-> tip operatiune: la intrari plecarea e o frontiera, la iesiri sosirea
  if (INTRA_IN.has(tip) && !isBorder(decl.start)) warnings.push('La „' + TIP_OPERATIUNE[tip] + '" plecarea ar trebui sa fie un birou vamal / punct de trecere a frontierei.');
  if (INTRA_OUT.has(tip) && !isBorder(decl.final)) warnings.push('La „' + TIP_OPERATIUNE[tip] + '" sosirea ar trebui sa fie un birou vamal / punct de trecere a frontierei.');
  return { ok: errors.length === 0, errors, warnings };
}

// ───────────────────────── Serializare XML (schema v2) ─────────────────────────

/** Atribut optional: se emite DOAR daca are continut. Tipurile optionale din schema sunt
 *  siruri cu `minLength=1` sau zecimale cu `minExclusive=0` — un `atribut=""` sau
 *  `greutateNeta="0.00"` INVALIDEAZA declaratia, nu o lasa neutra. */
const at = (nume, val) => (val === '' || val == null ? '' : ` ${nume}="${esc(val)}"`);
const atNum = (nume, val) => (Number(val) > 0 ? ` ${nume}="${num2(val)}"` : '');

/** Capat de traseu: codPtf/codBirouVamal stau pe ELEMENT, adresa interna intr-un copil
 *  `<locatie>` (schema: LocTraseuRutierType are secventa cu `locatie` minOccurs=0).
 *  La frontiera (PTF / birou vamal) nu exista adresa interna, deci elementul ramane gol. */
function locXml(tag, l) {
  const attrs = at('codPtf', l.codPtf) + at('codBirouVamal', l.codBirouVamal);
  // codJudet + denumireLocalitate + denumireStrada sunt TOATE obligatorii in <locatie>;
  // fara ele nu emitem elementul (validate() semnaleaza deja lipsa).
  if (!(l.codJudet && l.denumireLocalitate && l.denumireStrada)) return `    <${tag}${attrs}/>`;
  const loc = `codJudet="${esc(l.codJudet)}" denumireLocalitate="${esc(l.denumireLocalitate)}"`
    + ` denumireStrada="${esc(l.denumireStrada)}"`
    + at('numar', l.numar) + at('codPostal', l.codPostal) + at('alteInfo', l.alteInfo);
  return `    <${tag}${attrs}>\n      <locatie ${loc}/>\n    </${tag}>`;
}

function eTransportXml(company, entry, td) {
  const d = buildDeclaration(company, entry, td);
  const t = d.transport;
  // ATENTIE: ordinea elementelor din <notificare> e o SECVENTA in schema (bunuri ->
  // partener -> dateTransport -> start -> final -> documente); nu o rearanja.
  const bunuri = d.bunuri.map((g) =>
    `    <bunuriTransportate codScopOperatiune="${esc(g.codScopOperatiune)}"`
    + at('codTarifar', g.codTarifar)
    + ` denumireMarfa="${esc(g.denumireMarfa)}"`
    + ` cantitate="${num2(g.cantitate)}" codUnitateMasura="${esc(g.codUnitateMasura)}"`
    + atNum('greutateNeta', g.greutateNeta)
    + ` greutateBruta="${num2(g.greutateBruta)}"`
    + ` valoareLeiFaraTva="${num2(g.valoareLeiFaraTva)}"/>`).join('\n');
  const remorci = at('nrRemorca1', t.nrRemorca1) + at('nrRemorca2', t.nrRemorca2);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- e-Transport generat de Contabo (schema eTransport v2, OUG 41/2022). Validare oficiala: XSD ANAF. -->
<eTransport xmlns="mfp:anaf:dgti:eTransport:declaratie:v2" codDeclarant="${esc(d.codDeclarant)}" refDeclarant="${esc(d.refDeclarant)}">
  <notificare codTipOperatiune="${esc(String(d.codTipOperatiune))}">
${bunuri}
    <partenerComercial codTara="${esc(d.partener.codTara)}"${at('cod', d.partener.cod)} denumire="${esc(d.partener.denumire)}"/>
    <dateTransport nrVehicul="${esc(t.nrVehicul)}"${remorci} codTaraOrgTransport="${esc(t.codTaraOrgTransport)}"${at('codOrgTransport', t.codOrgTransport)} denumireOrgTransport="${esc(t.denumireOrgTransport)}" dataTransport="${esc(t.dataTransport)}"/>
${locXml('locStartTraseuRutier', d.start)}
${locXml('locFinalTraseuRutier', d.final)}
    <documenteTransport tipDocument="${esc(d.document.tipDocument)}"${at('numarDocument', d.document.numarDocument)} dataDocument="${esc(d.document.dataDocument)}"${at('observatii', d.document.observatii)}/>
  </notificare>
</eTransport>
`;
}

module.exports = {
  TIP_OPERATIUNE, SCOP_OPERATIUNE, SCOP_ADMIS, TIP_DOCUMENT, JUDETE,
  judetCod, defaultTipOperatiune, isEtransportEligible, ELIGIBLE_TYPES,
  buildDeclaration, validate, eTransportXml, valoareFaraTva,
};
