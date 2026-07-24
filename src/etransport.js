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
const TIP_OPERATIUNE = {
  10: 'Achizitie intracomunitara',
  20: 'Livrare intracomunitara',
  30: 'Transport pe teritoriul national (tranzactie interna)',
  40: 'Import',
  50: 'Export',
  60: 'Tranzactie intracomunitara - tranzit (intrare/iesire)',
  70: 'Tranzactie non-UE - tranzit',
};
// Scopul operatiunii (codScopOperatiune) — de ce se misca marfa.
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
  801: 'Operatiuni in sistem lohn (UE)',
  802: 'Operatiuni in sistem lohn (non-UE)',
  901: 'Stocuri la dispozitia clientului',
  1001: 'Operatiuni de returnare',
  9999: 'Altele',
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
    nrCrt,
    codScopOperatiune: String(g.codScop || td.codScopOperatiune || '101'),
    codTarifar: String(g.codTarifar || '').replace(/\s/g, ''),
    denumireMarfa: String(g.denumire || g.nume || 'Marfa').slice(0, 500),
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

function buildLoc(loc) {
  loc = loc || {};
  return {
    codBirouVamal: String(loc.codBirouVamal || '').trim(),
    codPtf: String(loc.codPtf || '').trim(), // punct de trecere a frontierei
    codJudet: judetCod(loc.judet || loc.codJudet),
    denumireLocalitate: String(loc.localitate || loc.denumireLocalitate || '').trim(),
    denumireStrada: String(loc.strada || loc.denumireStrada || '').trim(),
    numar: String(loc.numar || '').trim(),
    codPostal: String(loc.codPostal || '').trim(),
    alteInfo: String(loc.alteInfo || '').slice(0, 500),
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
      cod: cui0(entry.partenerCui),
      denumire: String(entry.partener || '').slice(0, 500),
    },
    transport: {
      codTaraOrgTransport: String(org.tara || 'RO').toUpperCase().slice(0, 2),
      codOrgTransport: orgCui,
      denumireOrgTransport: String(org.nume || company.nume || '').slice(0, 500),
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
      observatii: String((td.document && td.document.observatii) || '').slice(0, 500),
    },
  };
}

// ───────────────────────── Validare pre-depunere ─────────────────────────

/** @returns { ok, errors:[], warnings:[] } — erori = depunere respinsa; avertismente = de verificat. */
function validate(decl) {
  const errors = []; const warnings = [];
  if (!decl.codDeclarant) errors.push('Lipseste CUI-ul declarantului (firma).');
  if (!TIP_OPERATIUNE[decl.codTipOperatiune]) errors.push('Tip de operatiune necunoscut: ' + decl.codTipOperatiune + '.');
  if (!decl.transport.nrVehicul) errors.push('Lipseste numarul de inmatriculare al vehiculului.');
  if (!decl.bunuri.length) errors.push('Nicio marfa de transportat.');
  for (const g of decl.bunuri) {
    if (!SCOP_OPERATIUNE[g.codScopOperatiune]) warnings.push('Scop de operatiune necunoscut la „' + g.denumireMarfa + '": ' + g.codScopOperatiune + '.');
    if (!g.codTarifar) errors.push('Lipseste codul tarifar (NC) la „' + g.denumireMarfa + '".');
    else if (!/^\d{4,8}$/.test(g.codTarifar)) warnings.push('Codul tarifar „' + g.codTarifar + '" nu pare valid (asteptam 4-8 cifre).');
    if (!(g.greutateBruta > 0)) errors.push('Lipseste greutatea bruta (kg) la „' + g.denumireMarfa + '".');
    if (!(g.valoareLeiFaraTva > 0)) warnings.push('Valoare 0 (fara TVA) la „' + g.denumireMarfa + '".');
  }
  // traseul rutier: fiecare capat are nevoie de judet+localitate SAU de un cod de vama/PTF (extern)
  const locOk = (l) => !!(l.codBirouVamal || l.codPtf || (l.codJudet && l.denumireLocalitate));
  if (!locOk(decl.start)) errors.push('Locul de plecare incomplet (judet + localitate sau cod vamal/PTF).');
  if (!locOk(decl.final)) errors.push('Locul de sosire incomplet (judet + localitate sau cod vamal/PTF).');
  return { ok: errors.length === 0, errors, warnings };
}

// ───────────────────────── Serializare XML (schema v2) ─────────────────────────

function locXml(tag, l) {
  const a = [];
  if (l.codBirouVamal) a.push(`codBirouVamal="${esc(l.codBirouVamal)}"`);
  if (l.codPtf) a.push(`codPtf="${esc(l.codPtf)}"`);
  if (l.codJudet) a.push(`codJudet="${esc(l.codJudet)}"`);
  if (l.denumireLocalitate) a.push(`denumireLocalitate="${esc(l.denumireLocalitate)}"`);
  if (l.denumireStrada) a.push(`denumireStrada="${esc(l.denumireStrada)}"`);
  if (l.numar) a.push(`numar="${esc(l.numar)}"`);
  if (l.codPostal) a.push(`codPostal="${esc(l.codPostal)}"`);
  if (l.alteInfo) a.push(`alteInfo="${esc(l.alteInfo)}"`);
  return `    <${tag} ${a.join(' ')}/>`;
}

function eTransportXml(company, entry, td) {
  const d = buildDeclaration(company, entry, td);
  const t = d.transport;
  const bunuri = d.bunuri.map((g) =>
    `    <bunuriTransportate nrCrt="${g.nrCrt}" codScopOperatiune="${esc(g.codScopOperatiune)}"`
    + ` codTarifar="${esc(g.codTarifar)}" denumireMarfa="${esc(g.denumireMarfa)}"`
    + ` cantitate="${num2(g.cantitate)}" codUnitateMasura="${esc(g.codUnitateMasura)}"`
    + ` greutateNeta="${num2(g.greutateNeta)}" greutateBruta="${num2(g.greutateBruta)}"`
    + ` valoareLeiFaraTva="${num2(g.valoareLeiFaraTva)}"/>`).join('\n');
  const remorci = (t.nrRemorca1 ? ` nrRemorca1="${esc(t.nrRemorca1)}"` : '') + (t.nrRemorca2 ? ` nrRemorca2="${esc(t.nrRemorca2)}"` : '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- e-Transport generat de Contabo (schema eTransport v2, OUG 41/2022). Validare oficiala: XSD ANAF. -->
<eTransport xmlns="mfp:anaf:dgti:eTransport:declaratie:v2" codDeclarant="${esc(d.codDeclarant)}" refDeclarant="${esc(d.refDeclarant)}">
  <transport codTipOperatiune="${esc(String(d.codTipOperatiune))}">
${bunuri}
    <partenerComercial codTara="${esc(d.partener.codTara)}" cod="${esc(d.partener.cod)}" denumire="${esc(d.partener.denumire)}"/>
    <dateTransport codTaraOrgTransport="${esc(t.codTaraOrgTransport)}" codOrgTransport="${esc(t.codOrgTransport)}" denumireOrgTransport="${esc(t.denumireOrgTransport)}" nrVehicul="${esc(t.nrVehicul)}"${remorci} dataTransport="${esc(t.dataTransport)}"/>
${locXml('locStartTraseuRutier', d.start)}
${locXml('locFinalTraseuRutier', d.final)}
    <documenteTransport tipDocument="${esc(d.document.tipDocument)}" numarDocument="${esc(d.document.numarDocument)}" dataDocument="${esc(d.document.dataDocument)}" observatii="${esc(d.document.observatii)}"/>
  </transport>
</eTransport>
`;
}

module.exports = {
  TIP_OPERATIUNE, SCOP_OPERATIUNE, TIP_DOCUMENT, JUDETE,
  judetCod, defaultTipOperatiune, isEtransportEligible, ELIGIBLE_TYPES,
  buildDeclaration, validate, eTransportXml, valoareFaraTva,
};
