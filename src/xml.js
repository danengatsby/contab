'use strict';

const { round2, period: periodOf } = require('./util');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const num2 = (x) => (Number(x) || 0).toFixed(2);
const roCui = (cui) => 'RO' + String(cui || '').replace(/^ro/i, '').replace(/\s/g, '');

const SALES_TYPES = new Set([
  'factura_vanzare_marfuri', 'factura_vanzare_produse', 'factura_vanzare_servicii', 'livrare_intracomunitara',
]);
const CREDIT_TYPES = new Set(['factura_storno_vanzare', 'factura_storno_cumparare']);
function isEFacturaEligible(entry) {
  return SALES_TYPES.has(entry.tip) || CREDIT_TYPES.has(entry.tip);
}
/** Doar documentele pe care firma le EMITE pot fi trimise in SPV. */
function isSendable(entry) {
  return SALES_TYPES.has(entry.tip) || entry.tip === 'factura_storno_vanzare';
}
/** Alege documentul potrivit: Invoice pentru vanzari, CreditNote pentru storno. */
function eFacturaXml(company, entry, partners) {
  return CREDIT_TYPES.has(entry.tip)
    ? eFacturaCreditNoteUBL(company, entry, partners)
    : eFacturaUBL(company, entry, partners);
}

/** Extrage din articolul contabil baza, TVA, cota si totalul facturii. */
function invoiceAmounts(entry) {
  let baza = 0; let tva = 0;
  for (const l of entry.lines) {
    if (['701', '704', '707', '708'].includes(l.credit)) baza = round2(baza + l.suma);
    if (l.credit === '4427') tva = round2(tva + l.suma);
  }
  const total = round2(baza + tva);
  const cota = baza > 0 && tva > 0 ? Math.round((tva / baza) * 100) : 0;
  return { baza, tva, total, cota };
}

const ITEM_NAME = {
  factura_vanzare_marfuri: 'Marfuri conform facturii',
  factura_vanzare_produse: 'Produse finite conform facturii',
  factura_vanzare_servicii: 'Servicii prestate conform facturii',
  livrare_intracomunitara: 'Livrare intracomunitara de bunuri',
};

const UM_MAP = {
  buc: 'C62', 'buc.': 'C62', bucata: 'C62', bucati: 'C62', kg: 'KGM', g: 'GRM', gram: 'GRM',
  l: 'LTR', litru: 'LTR', ora: 'HUR', ore: 'HUR', mp: 'MTK', m2: 'MTK', mc: 'MTQ', m3: 'MTQ',
  ml: 'MTR', m: 'MTR', km: 'KMT', set: 'SET', luna: 'MON', zi: 'DAY', to: 'TNE', tona: 'TNE',
  pereche: 'PR', cutie: 'BX', pachet: 'PK',
};
function umCode(um) {
  return UM_MAP[String(um || '').toLowerCase().trim()] || 'C62';
}

function taxCategoryXml(cota, ic, indent) {
  const i = indent || '        ';
  if (ic) {
    return `${i}<cbc:ID>K</cbc:ID>\n${i}<cbc:Percent>0.00</cbc:Percent>\n` +
      `${i}<cbc:TaxExemptionReasonCode>VATEX-EU-IC</cbc:TaxExemptionReasonCode>\n` +
      `${i}<cbc:TaxExemptionReason>Livrare intracomunitara scutita cu drept de deducere</cbc:TaxExemptionReason>\n` +
      `${i}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>`;
  }
  const id = cota === 0 ? 'O' : 'S';
  return `${i}<cbc:ID>${id}</cbc:ID>\n${i}<cbc:Percent>${num2(cota)}</cbc:Percent>\n${i}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>`;
}

/** Genereaza factura in format UBL 2.1 (CIUS-RO) pentru e-Factura. */
function eFacturaUBL(company, entry, partners) {
  if (!isEFacturaEligible(entry)) throw new Error('Inregistrarea nu este o factura emisa.');
  const ic = entry.tip === 'livrare_intracomunitara';
  const cur = 'RON';
  const id = entry.document || entry.id;
  const custCui = entry.partenerCui || '';
  const pinfo = (custCui && partners && partners[custCui.replace(/^ro/i, '')]) || {};
  const cust = pinfo.den || entry.partener || 'Client';

  // Linii + subtotaluri de TVA (din linii detaliate, daca exista)
  let baza = 0; let tva = 0; let lineXml = ''; let subtotalsXml = '';
  const items = (!ic && entry.items && entry.items.length) ? entry.items : null;
  if (items) {
    const groups = {};
    items.forEach((it, i) => {
      const base = round2(it.cantitate * it.pret);
      baza = round2(baza + base);
      groups[it.cota] = round2((groups[it.cota] || 0) + base);
      lineXml += `  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${umCode(it.um)}">${num2(it.cantitate)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${cur}">${num2(base)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${esc(it.nume)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
${taxCategoryXml(it.cota, false, '        ')}
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${cur}">${num2(it.pret)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>\n`;
    });
    // TVA pe categorie (cota) — TaxTotal = suma subtotalurilor (conform BR-CO-14)
    for (const cota of Object.keys(groups).sort((a, b) => b - a)) {
      const base = groups[cota];
      const tax = round2((base * Number(cota)) / 100);
      tva = round2(tva + tax);
      subtotalsXml += `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${cur}">${num2(base)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${cur}">${num2(tax)}</cbc:TaxAmount>
      <cac:TaxCategory>
${taxCategoryXml(Number(cota), false, '        ')}
      </cac:TaxCategory>
    </cac:TaxSubtotal>\n`;
    }
  } else {
    const a = invoiceAmounts(entry);
    baza = a.baza; tva = a.tva;
    const itemName = ITEM_NAME[entry.tip] || (entry.tipNume || 'Produse/servicii');
    subtotalsXml = `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${cur}">${num2(baza)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${cur}">${num2(tva)}</cbc:TaxAmount>
      <cac:TaxCategory>
${taxCategoryXml(a.cota, ic, '        ')}
      </cac:TaxCategory>
    </cac:TaxSubtotal>\n`;
    lineXml = `  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${cur}">${num2(baza)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${esc(itemName)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
${taxCategoryXml(a.cota, ic, '        ')}
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${cur}">${num2(baza)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>\n`;
  }
  const total = round2(baza + tva);

  const custTax = custCui
    ? `\n      <cac:PartyTaxScheme>\n        <cbc:CompanyID>${esc(roCui(custCui))}</cbc:CompanyID>\n        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>\n      </cac:PartyTaxScheme>`
    : '';
  const custLegalId = custCui ? `\n        <cbc:CompanyID>${esc(roCui(custCui))}</cbc:CompanyID>` : '';
  const custCounty = pinfo.judet ? `\n        <cbc:CountrySubentity>${esc(pinfo.judet)}</cbc:CountrySubentity>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1</cbc:CustomizationID>
  <cbc:ID>${esc(id)}</cbc:ID>
  <cbc:IssueDate>${esc(entry.data)}</cbc:IssueDate>
  <cbc:DueDate>${esc(entry.data)}</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PostalAddress>
        <cbc:StreetName>${esc(company.adresa || '-')}</cbc:StreetName>
        <cbc:CityName>${esc(company.oras || '-')}</cbc:CityName>
        <cbc:CountrySubentity>${esc(company.judet || 'RO-B')}</cbc:CountrySubentity>
        <cac:Country><cbc:IdentificationCode>RO</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(roCui(company.cui))}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(company.nume)}</cbc:RegistrationName>
        <cbc:CompanyID>${esc(company.regCom || roCui(company.cui))}</cbc:CompanyID>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PostalAddress>
        <cbc:StreetName>${esc(pinfo.adresa || '-')}</cbc:StreetName>
        <cbc:CityName>${esc(pinfo.oras || '-')}</cbc:CityName>${custCounty}
        <cac:Country><cbc:IdentificationCode>${esc(pinfo.tara || 'RO')}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>${custTax}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(cust)}</cbc:RegistrationName>${custLegalId}
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
${company.iban ? `  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>31</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>${esc(String(company.iban).replace(/\s/g, ''))}</cbc:ID>${company.banca ? `
      <cbc:Name>${esc(company.banca)}</cbc:Name>` : ''}
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
` : ''}  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${cur}">${num2(tva)}</cbc:TaxAmount>
${subtotalsXml}  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${cur}">${num2(baza)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${cur}">${num2(baza)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${cur}">${num2(total)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${cur}">${num2(total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lineXml}</Invoice>
`;
}

function ym(period) {
  const q = String(period || '').match(/^(\d{4})-Q([1-4])$/);
  if (q) return { an: q[1], luna: String(Number(q[2]) * 3) }; // trimestru: luna finala (D300/D394 trimestrial)
  const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
  return m ? { an: m[1], luna: String(Number(m[2])) } : { an: String(new Date().getFullYear()), luna: '1' };
}

/** Nr. de evidenta a platii (23 de cifre, structura oficiala): "10" + codul creantei pe 3
 *  cifre + "01" + LLAA (sfarsitul perioadei) + ZZLLAA (scadenta = 25 a lunii urmatoare)
 *  + "0000" + suma de control (ultimele 2 cifre ale sumei primelor 21 de cifre). */
function nrEvidPlata(cod3, luna, an) {
  const mm = String(luna).padStart(2, '0'); const aa = String(an).slice(-2);
  const next = Number(luna) === 12 ? { mm: '01', aa: String(Number(aa) + 1).padStart(2, '0') } : { mm: String(Number(luna) + 1).padStart(2, '0'), aa };
  const p21 = '10' + cod3 + '01' + mm + aa + '25' + next.mm + next.aa + '0000';
  const ctl = String(p21.split('').reduce((s, c) => s + Number(c), 0)).slice(-2).padStart(2, '0');
  return p21 + ctl;
}

/** Atributele declarantului (intocmitorului) — incluse doar cand datele exista. */
function declarant(who) {
  if (!who || !who.nume) return '';
  let a = ` nume_declar="${esc(who.nume)}"`;
  if (who.prenume) a += ` prenume_declar="${esc(who.prenume)}"`;
  if (who.functie) a += ` functie_declar="${esc(who.functie)}"`;
  return a;
}

/** D300 — decont TVA pe schema OFICIALA v12 (mfp:anaf:dgti:d300:declaratie:v12).
 *  Forma e plata: toate valorile sunt atribute pe radacina, randurile decontului sunt Rn_1
 *  (baza) / Rn_2 (TVA), in LEI INTREGI (tip N(15) in XSD — nu zecimale). Maparea cota->rand
 *  si formulele de total urmeaza structura_D300_v12 + verificarile DUKIntegrator. */
// Randurile pe cote (dupa 01.08.2025): livrari 21->R9, 11->R10, 9(art.III L141/2025)->R11;
// istorice (perioade vechi): 19->R69, 5->R71. Achizitii: 21->R22, 11->R23, 5->R24, 9->R74, 19->R75.
const D300_RAND_V = { 21: 'R9', 11: 'R10', 9: 'R11', 19: 'R69', 5: 'R71' };
const D300_RAND_C = { 21: 'R22', 11: 'R23', 5: 'R24', 9: 'R74', 19: 'R75' };
function d300Xml(company, period, d, who) {
  const { an, luna } = ym(period);
  const lei = (v) => String(Math.round(Number(v) || 0));
  const A = {}; // atributele-randuri, doar cele cu valoare
  const put = (rand, baza, tva) => {
    if (!rand) return;
    A[rand + '_1'] = (Number(A[rand + '_1']) || 0) + Math.round(baza || 0);
    A[rand + '_2'] = (Number(A[rand + '_2']) || 0) + Math.round(tva || 0);
  };
  for (const c of d.coteV || []) put(D300_RAND_V[c.cota], c.baza, c.tva);
  for (const c of d.coteC || []) put(D300_RAND_C[c.cota], c.baza, c.tva);
  // Totaluri (formulele oficiale): R17 = total taxa colectata, R27 = total taxa deductibila.
  const sum = (rows, col) => rows.reduce((s, r) => s + (Number(A[r + col]) || 0), 0);
  const RV = Object.values(D300_RAND_V); const RC = Object.values(D300_RAND_C);
  A.R17_1 = sum(RV, '_1'); A.R17_2 = sum(RV, '_2');
  A.R27_1 = sum(RC, '_1'); A.R27_2 = sum(RC, '_2');
  // Sold: R28 = taxa dedusa (fara regularizari => R27); R32 = total dedus; apoi inchiderea
  // R33/R34 (suma negativa / taxa de plata) si cumulat R37/R40 -> R41 (plata) / R42 (recuperat).
  A.R28_2 = A.R27_2; A.R32_2 = A.R28_2;
  A.R33_2 = Math.max(A.R32_2 - A.R17_2, 0); A.R34_2 = Math.max(A.R17_2 - A.R32_2, 0);
  A.R37_2 = A.R34_2; A.R40_2 = A.R33_2;
  A.R41_2 = Math.max(A.R37_2 - A.R40_2, 0); A.R42_2 = Math.max(A.R40_2 - A.R37_2, 0);
  const emise = Object.keys(A).filter((k) => A[k] !== 0 || /^R(17|27|41|42)_/.test(k));
  const randuri = emise.map((k) => `  ${k}="${lei(A[k])}"`).join('\n');
  // totalPlata_A NU e plata, ci SUMA DE CONTROL: suma tuturor campurilor-rand emise.
  const sumaControl = emise.reduce((s, k) => s + Math.round(A[k] || 0), 0);
  // nr_evid (nr. de evidenta a platii), structura oficiala pe 23 de cifre:
  // "10" + 301..304 (dupa tip_decont L/T/S/A) + "01" + LLAA (sfarsitul perioadei)
  // + ZZLLAA (scadenta = 25 a lunii urmatoare) + "0000" + suma de control (ultimele 2 cifre
  // ale sumei primelor 21 de cifre).
  const tipDecont = company.perioadaTva || 'L';
  const nrEvid = nrEvidPlata({ L: '301', T: '302', S: '303', A: '304' }[tipDecont] || '301', luna, an);
  const w = who && who.nume ? who : { nume: 'Administrator', prenume: '', functie: 'Administrator' };
  const adresa = [company.adresa, company.oras, company.judet].filter(Boolean).join(', ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- D300 v12 generat de Contabo. Verificare oficiala: scripts/valideaza-duk.sh D300 fisier.xml -->
<declaratie300 xmlns="mfp:anaf:dgti:d300:declaratie:v12"
  luna="${esc(luna)}" an="${esc(an)}" depusReprezentant="0" bifa_interne="0" temei="0"
  nume_declar="${esc(w.nume)}" prenume_declar="${esc(w.prenume || '-')}" functie_declar="${esc(w.functie || 'Administrator')}"
  cui="${esc(String(company.cui).replace(/^ro/i, ''))}" den="${esc(company.nume)}"
  adresa="${esc(adresa || '-')}"${company.telefon ? `\n  telefon="${esc(company.telefon)}"` : ''}${company.email ? `\n  mail="${esc(company.email)}"` : ''}
  banca="${esc(company.banca || '-')}" cont="${esc(String(company.iban || '-').replace(/\s/g, ''))}"
  caen="${esc(company.caen || '0000')}" tip_decont="${esc(tipDecont)}"
  pro_rata="${esc(company.proRataTva || 100)}"
  bifa_cereale="N" bifa_mob="N" bifa_disp="N" bifa_cons="N" solicit_ramb="N"
  nr_evid="${nrEvid}" totalPlata_A="${lei(sumaControl)}"
${randuri}
/>
`;
}

/** Zile lucratoare intr-o luna: luni-vineri minus sarbatorile legale romanesti (inclusiv
 *  cele mobile — Pastele ortodox prin algoritmul iulian Meeus + 13 zile, Vinerea Mare,
 *  a doua zi de Pasti, Rusaliile). Validatorul D112 verifica orele/zilele contra NZL. */
function zileLucratoareLuna(an, luna) {
  const a = an % 4; const b = an % 7; const c = an % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const paste = new Date(Date.UTC(an, Math.floor((d + e + 114) / 31) - 1, ((d + e + 114) % 31) + 1 + 13));
  const rel = (ofs) => { const x = new Date(paste); x.setUTCDate(x.getUTCDate() + ofs); return x; };
  const libere = new Set([[0, 1], [0, 2], [0, 6], [0, 7], [0, 24], [4, 1], [5, 1], [7, 15], [10, 30], [11, 1], [11, 25], [11, 26]]
    .map(([m, z]) => m + '-' + z));
  for (const ofs of [-2, 0, 1, 49, 50]) { const x = rel(ofs); libere.add(x.getUTCMonth() + '-' + x.getUTCDate()); }
  let z = 0;
  for (const dt = new Date(Date.UTC(an, luna - 1, 1)); dt.getUTCMonth() === luna - 1; dt.setUTCDate(dt.getUTCDate() + 1)) {
    if (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) continue;
    if (libere.has(dt.getUTCMonth() + '-' + dt.getUTCDate())) continue;
    z += 1;
  }
  return z;
}

/** D112 — declaratia unica angajator, pe schema OFICIALA curenta (declaratieUnica,
 *  mfp:anaf:dgti:declaratie_unica:declaratie:v7). Structura: <angajator> cu obligatiile de
 *  plata pe coduri (angajatorA: 602 impozit, 412 CAS, 432 CASS, 480 CAM — Nomenclator 3)
 *  + contoarele angajatorB; apoi cate un <asigurat> per salariat, cu sectiunea A (baze si
 *  contributii) si E3 (impozitul retinut). Valori in LEI INTREGI.
 *  Verificare oficiala: scripts/valideaza-duk.sh D112 fisier.xml */
function d112Xml(company, period, sp, who) {
  const { an, luna } = ym(period);
  const lei = (v) => String(Math.round(Number(v) || 0));
  const t = sp.totals;
  const w = who && who.nume ? who : { nume: 'Administrator', prenume: '-', functie: 'Administrator' };
  // obligatiile angajatorului — codurile bugetare sunt cele pre-completate de PDF-ul
  // inteligent ANAF: contul unic 5503 pentru impozit/CAS/CASS, 204703 pentru CAM
  const oblig = [
    { cod: '602', bugetar: '5503XXXXXX', suma: t.impozit }, // impozit pe venit din salarii
    // CAS/CASS retinute de la asigurati + partea ANGAJATORULUI la norma partiala sub minim
    { cod: '412', bugetar: '5503XXXXXX', suma: t.cas + (t.casAngajator || 0) },
    { cod: '432', bugetar: '5503XXXXXX', suma: t.cass + (t.cassAngajator || 0) },
    { cod: '480', bugetar: '20470300XX', suma: t.cam },     // contributia asiguratorie pt. munca
  ].filter((o) => Math.round(o.suma) > 0);
  const totalPlata = oblig.reduce((s, o) => s + Math.round(o.suma), 0);
  // total venit realizat in conditii normale de munca (C1_11; C1_T1 = totalul pe conditii)
  const bazaCasTotal = sp.rows.reduce((s, r) => s + Math.round(r.brut + (r.avantaje || 0) + (r.indemnizatieCM || 0)), 0);
  // casa de sanatate din judetul firmei (Nomenclator 2): coduri de judet; Bucuresti = "_B"
  const jud = String(company.judet || '').replace(/^RO-/i, '').toUpperCase();
  const casaAng = jud === 'B' || !jud ? '_B' : jud;
  const obligXml = oblig.map((o) =>
    `    <angajatorA A_codBugetar="${o.bugetar}" A_codOblig="${o.cod}" A_datorat="${lei(o.suma)}" A_scutit="0" A_plata="${lei(o.suma)}"/>`).join('\n');
  const zileLucratoare = zileLucratoareLuna(Number(an), Number(luna));
  // data in format romanesc ZZ.LL.AAAA (validatorul respinge ISO)
  const dataRo = (iso) => {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? m[3] + '.' + m[2] + '.' + m[1] : iso;
  };
  const asigurati = sp.rows.map((r, i) => {
    const parts = String(r.nume || '').trim().split(/\s+/);
    const numeFam = parts.pop() || '-'; const pren = parts.join(' ') || '-';
    const bazaCass = Math.round(r.brut + (r.tichete || 0) + (r.avantaje || 0));
    const bazaCas = Math.round(r.brut + (r.avantaje || 0) + (r.indemnizatieCM || 0));
    const venitImpozabil = Math.max(Math.round(bazaCas - r.cas - r.cass - (r.deducere || 0)), 0);
    const ded = Math.round(r.deducere || 0);
    return `  <asigurat idAsig="${i + 1}" cnpAsig="${esc(r.cnp)}" cisAsig="${esc(r.cnp)}" numeAsig="${esc(numeFam)}" prenAsig="${esc(pren)}"
    dataAng="${esc(dataRo(r.dataAngajare || an + '-01-01'))}" casaSn="${esc(casaAng)}" asigCI="1" asigSO="1" Timp_E3="${lei(r.impozit)}">
    <asiguratA A_1="1" A_2="0" A_3="N" A_4="8" A_5="${lei(r.brut)}" A_6="${zileLucratoare * 8}" A_7="0" A_8="${zileLucratoare}"
      A_9="${lei(r.brut)}" A_sal1="${lei(r.salariuBaza || r.brut)}" A_sal2="${lei(r.brut)}"
      A_11="${bazaCass}" A_12="${lei(r.cass)}" A_13="${bazaCas}" A_14="${lei(r.cas)}"/>
    <asiguratE1 E1_1="${lei(r.brut)}" E1_2="${lei(r.cas + r.cass)}" E1_3="${r.persoane || 0}" E1_4="${ded}"
      E1_41="${ded}" E1_42="0" E1_421="0" E1_422="0" E1_5="0" E1_6="${venitImpozabil}" E1_7="${lei(r.impozit)}"/>
    <asiguratE3 E3_1="A" E3_2="1" E3_3="1" E3_4="P" E3_8="${lei(r.brut)}" E3_9="${lei(r.cas + r.cass)}"
      E3_14="${venitImpozabil}" E3_15="${lei(r.impozit)}" E3_16="0" E3_19="0" E3_21="0"/>
  </asigurat>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- D112 (declaratieUnica v6) generat de Contabo. Verificare: scripts/valideaza-duk.sh D112 fisier.xml -->
<declaratieUnica xmlns="mfp:anaf:dgti:declaratie_unica:declaratie:v7"
  luna_r="${esc(luna)}" an_r="${esc(an)}"
  nume_declar="${esc(w.nume)}" prenume_declar="${esc(w.prenume || '-')}" functie_declar="${esc(w.functie || 'Administrator')}">
  <angajator cif="${esc(String(company.cui).replace(/^ro/i, ''))}" caen="${esc(company.caen || '0000')}" den="${esc(company.nume)}"
    casaAng="${esc(casaAng)}" datCAM="1" bifa_CAM="0" totalPlata_A="${lei(totalPlata)}">
${obligXml}
    <angajatorB B_cnp="${sp.rows.length}" B_sanatate="${sp.rows.length}" B_pensie="${sp.rows.filter((r) => r.cas > 0).length}" B_brutSalarii="${lei(t.brut)}" B_sal="${sp.rows.length}"/>
    <angajatorC1 C1_11="${bazaCasTotal}" C1_T1="${bazaCasTotal}"/>
    <angajatorC3/>
    <angajatorC4 C4_baza="${lei(t.brut)}" C4_ct="${lei(t.cam)}"/>
  </angajator>
${asigurati}
</declaratieUnica>
`;
}

/** D394 — declaratie informativa pe schema OFICIALA v5 (mfp:anaf:dgti:d394:declaratie:v5).
 *  Structura: atribute pe radacina (identificare + suma de control), apoi <informatii>
 *  (contoare + TVA pe cote), <rezumat1> (pe tip partener x cota), <rezumat2> (pe cota),
 *  <op1> (detaliu pe partener). Valori in LEI INTREGI. Operatiunile fara CUI de partener
 *  nu intra in detaliu (D394 e lista B2B pe CUI); achizitiile de la producatori PF pe fila
 *  de carnet (`pf`) intra ca op1 tip="N" cu tip_partener=2.
 *  Verificare oficiala: scripts/valideaza-duk.sh D394 fisier.xml */
function d394Xml(company, period, vj, who, pf) {
  const { an, luna } = ym(period);
  const lei = (v) => String(Math.round(Number(v) || 0));
  const cuiDigits = (c) => String(c || '').replace(/^ro/i, '').replace(/\s/g, '');
  // agregare op1 pe (tip, partener, cota); taxarea inversa are tipuri proprii (V/C)
  const ops = new Map();
  const addOp = (tip, tp, cota, cui, den, baza, tva, nrDoc) => {
    const k = tip + '|' + cui + '|' + cota;
    const e = ops.get(k) || { tip, tp, cota, cui, den, nr: 0, baza: 0, tva: 0 };
    e.nr += nrDoc || 1; e.baza += baza; e.tva += tva || 0;
    if (!e.den && den) e.den = den;
    ops.set(k, e);
  };
  for (const r of vj.vanzari || []) {
    const cui = cuiDigits(r.cui); if (!cui) continue;
    addOp(r.taxareInversa ? 'V' : 'L', 1, r.cota, cui, r.partener, r.baza, r.tva);
  }
  for (const r of vj.cumparari || []) {
    const cui = cuiDigits(r.cui); if (!cui) continue;
    addOp(r.taxareInversa ? 'C' : 'A', 1, r.cota, cui, r.partener, r.baza, r.tva);
  }
  for (const r of (pf && pf.rows) || []) addOp('N', 2, 0, r.cnp || '', r.partener, r.total, 0, r.nr);
  const opList = [...ops.values()];
  // rezumat1: totaluri pe (tip_partener, cota), cu coloane pe tipul operatiunii
  const rez1 = new Map();
  for (const o of opList) {
    const k = o.tp + '|' + o.cota;
    const e = rez1.get(k) || { tp: o.tp, cota: o.cota, L: null, V: null, A: null, C: null, N: null };
    e[o.tip] = e[o.tip] || { nr: 0, baza: 0, tva: 0 };
    e[o.tip].nr += o.nr; e[o.tip].baza += o.baza; e[o.tip].tva += o.tva;
    rez1.set(k, e);
  }
  const rez1Xml = [...rez1.values()].map((e) => {
    const z = { nr: 0, baza: 0, tva: 0 };
    let a = `tip_partener="${e.tp}" cota="${e.cota}"`;
    // pentru tip_partener 1/3/4 cu cota <> 0, coloanele L/A/AI/C sunt OBLIGATORII,
    // chiar si pe zero (regulile R40-R58 din validator)
    if (e.cota !== 0 && [1, 3, 4].includes(e.tp)) {
      const L = e.L || z; a += ` facturiL="${L.nr}" bazaL="${lei(L.baza)}" tvaL="${lei(L.tva)}"`;
      if (e.V) a += ` facturiV="${e.V.nr}" bazaV="${lei(e.V.baza)}"`;
      const A = e.A || z; a += ` facturiA="${A.nr}" bazaA="${lei(A.baza)}" tvaA="${lei(A.tva)}"`;
      const ai = e.AI || z; a += ` facturiAI="${ai.nr}" bazaAI="${lei(ai.baza)}" tvaAI="${lei(ai.tva)}"`;
      const c = e.C || z; a += ` facturiC="${c.nr}" bazaC="${lei(c.baza)}" tvaC="${lei(c.tva)}"`;
    } else {
      if (e.L) a += ` facturiL="${e.L.nr}" bazaL="${lei(e.L.baza)}" tvaL="${lei(e.L.tva)}"`;
      if (e.V) a += ` facturiV="${e.V.nr}" bazaV="${lei(e.V.baza)}"`;
      if (e.A) a += ` facturiA="${e.A.nr}" bazaA="${lei(e.A.baza)}" tvaA="${lei(e.A.tva)}"`;
      if (e.C) a += ` facturiC="${e.C.nr}" bazaC="${lei(e.C.baza)}" tvaC="${lei(e.C.tva)}"`;
    }
    if (e.N) {
      // achizitii de la PF (document_N=1 fila carnet): coloanele LS obligatorii (R41/R42)
      // + detaliul pe nomenclatorul de bunuri (R35), oglinda op11 (codPR 35 = alte produse)
      a += ` facturiLS="0" bazaLS="0" facturiN="${e.N.nr}" document_N="1" bazaN="${lei(e.N.baza)}"`;
      return `  <rezumat1 ${a}>\n    <detaliu bun="35" nrN="${e.N.nr}" valN="${lei(e.N.baza)}"/>\n  </rezumat1>`;
    }
    return `  <rezumat1 ${a}/>`;
  }).join('\n');
  // rezumat2: totaluri pe cota (facturile simplificate nu sunt urmarite separat => 0)
  const cote = [...new Set(opList.filter((o) => 'LA'.includes(o.tip)).map((o) => o.cota))].sort((a, b) => b - a).slice(0, 5);
  const rez2Of = (cota) => {
    const t = { nrL: 0, bazaL: 0, tvaL: 0, nrA: 0, bazaA: 0, tvaA: 0 };
    for (const o of opList) {
      if (o.cota !== cota) continue;
      if (o.tip === 'L') { t.nrL += o.nr; t.bazaL += o.baza; t.tvaL += o.tva; }
      if (o.tip === 'A') { t.nrA += o.nr; t.bazaA += o.baza; t.tvaA += o.tva; }
    }
    return t;
  };
  const rez2 = cote.map((c) => ({ cota: c, t: rez2Of(c) }));
  const rez2Xml = rez2.map(({ cota, t }) =>
    `  <rezumat2 cota="${cota}" bazaFSLcod="0" TVAFSLcod="0" bazaFSL="0" TVAFSL="0" bazaFSA="0" TVAFSA="0" bazaFSAI="0" TVAFSAI="0" bazaBFAI="0" TVABFAI="0"`
    + ` nrFacturiL="${t.nrL}" bazaL="${lei(t.bazaL)}" tvaL="${lei(t.tvaL)}" nrFacturiA="${t.nrA}" bazaA="${lei(t.bazaA)}" tvaA="${lei(t.tvaA)}"`
    + ` nrFacturiAI="0" bazaAI="0" tvaAI="0" baza_incasari_i1="0" tva_incasari_i1="0" baza_incasari_i2="0" tva_incasari_i2="0" bazaL_PF="0" tvaL_PF="0"/>`).join('\n');
  // informatii: contoare de parteneri pe tip + TVA colectata/dedusa pe cote
  const nrCui = [1, 2, 3, 4].map((tp) => new Set(opList.filter((o) => o.tp === tp).map((o) => o.cui)).size);
  const tvaCote = { col: {}, ded: {} };
  for (const o of opList) {
    if (o.tip === 'L') tvaCote.col[o.cota] = (tvaCote.col[o.cota] || 0) + o.tva;
    if (o.tip === 'A') tvaCote.ded[o.cota] = (tvaCote.ded[o.cota] || 0) + o.tva;
  }
  // tvaCol/tvaDed pe cote se completeaza DOAR la sistemul de TVA la incasare (R135B/R143B);
  // atunci insa TOATE cotele sunt obligatorii, si cele fara operatiuni (pe zero) — R135-R146
  const tvaAttr = !company.tvaLaIncasare ? '' : ['col', 'ded'].map((f) => [24, 21, 20, 19, 11, 9, 5]
    .map((c) => ` tva${f === 'col' ? 'Col' : 'Ded'}${c}="${lei(tvaCote[f][c] || 0)}"`).join('')).join('');
  const nrFacturi = opList.filter((o) => o.tip === 'L' || o.tip === 'V').reduce((s, o) => s + o.nr, 0);
  // serieFacturi tip=2 (facturi emise): plaja pe fiecare serie, derivata din documentele emise
  // (regula R131: nrFacturi > 0 <=> exista serieFacturi cu tip 2)
  const serii = new Map();
  for (const r of vj.vanzari || []) {
    const m = String(r.document || '').trim().match(/^(.*?)\s*(\d+)$/);
    const serie = m ? m[1].trim() : String(r.document || '').trim();
    const nr = m ? Number(m[2]) : null;
    const e = serii.get(serie) || { min: nr, max: nr };
    if (nr != null) { e.min = e.min == null ? nr : Math.min(e.min, nr); e.max = e.max == null ? nr : Math.max(e.max, nr); }
    serii.set(serie, e);
  }
  // regula R112: emisele (tip 2) cer si plaja alocata (tip 1) — o emitem identica cu plaja emisa
  const seriiXml = nrFacturi === 0 ? '' : [...serii.entries()].map(([serie, e]) => ['1', '2'].map((tip) =>
    `  <serieFacturi tip="${tip}"${serie ? ` serieI="${esc(serie)}"` : ''} nrI="${e.min != null ? e.min : 1}"${e.max != null ? ` nrF="${e.max}"` : ''}/>`).join('\n')).join('\n');
  const zeroAI = [24, 21, 11, 20, 19, 9, 5].map((c) => ` tvaDedAI${c}="0"`).join('');
  // suma de control (formula oficiala): parteneri + bazele din rezumat2
  const sumaControl = nrCui.reduce((s, n) => s + n, 0)
    + rez2.reduce((s, { t }) => s + Math.round(t.bazaL) + Math.round(t.bazaA), 0);
  const op1Xml = opList.map((o) => {
    const attrs = `tip="${o.tip}" tip_partener="${o.tp}" cota="${o.cota}"${o.cui ? ` cuiP="${esc(o.cui)}"` : ''} denP="${esc(o.den || '-')}"`
      + `${o.tip === 'N' ? ' tip_document="1"' : ''} nrFact="${o.nr}" baza="${lei(o.baza)}"${o.tip === 'L' || o.tip === 'A' || o.tip === 'C' ? ` tva="${lei(o.tva)}"` : ''}`;
    // achizitiile de la PF (tip N) cer detaliul op11 pe categorii de produse (R233.6);
    // fara categorie in datele-sursa, totul intra la codPR 35 (alte produse)
    if (o.tip !== 'N') return `  <op1 ${attrs}/>`;
    return `  <op1 ${attrs}>\n    <op11 nrFactPR="${o.nr}" codPR="35" bazaPR="${lei(o.baza)}"/>\n  </op1>`;
  }).join('\n');
  const w = who && who.nume ? who : { nume: 'Administrator', prenume: '', functie: 'Administrator' };
  const numeIntocmit = [w.prenume, w.nume].filter(Boolean).join(' ') || 'Administrator';
  const adresa = [company.adresa, company.oras, company.judet].filter(Boolean).join(', ');
  const cui = cuiDigits(company.cui);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- D394 v5 generat de Contabo. Verificare oficiala: scripts/valideaza-duk.sh D394 fisier.xml -->
<declaratie394 xmlns="mfp:anaf:dgti:d394:declaratie:v5"
  luna="${esc(luna)}" an="${esc(an)}" tip_D394="${esc(company.perioadaTva || 'L')}"
  sistemTVA="${company.tvaLaIncasare ? 1 : 0}" op_efectuate="${opList.length ? 1 : 0}"
  cui="${esc(cui)}" caen="${esc(company.caen || '0000')}" den="${esc(company.nume)}"
  adresa="${esc(adresa || '-')}" telefon="${esc(company.telefon || '-')}"
  totalPlata_A="${lei(sumaControl)}"
  denR="${esc(numeIntocmit)}" functie_reprez="${esc(w.functie || 'Administrator')}" adresaR="${esc(adresa || '-')}"
  tip_intocmit="0" den_intocmit="${esc(numeIntocmit)}" cif_intocmit="${esc(cui)}" calitate_intocmit="${esc(w.functie || 'Administrator')}"
  optiune="0" prsAfiliat="0">
  <informatii nrCui1="${nrCui[0]}" nrCui2="${nrCui[1]}" nrCui3="${nrCui[2]}" nrCui4="${nrCui[3]}"
    nr_BF_i1="0" incasari_i1="0" incasari_i2="0" nrFacturi_terti="0" nrFacturi_benef="0"
    nrFacturi="${nrFacturi}" nrFacturiL_PF="0" nrFacturiLS_PF="0" val_LS_PF="0"${zeroAI}${tvaAttr} solicit="0"/>
${rez1Xml}
${rez2Xml}${seriiXml ? '\n' + seriiXml : ''}
${op1Xml}
</declaratie394>
`;
}

/** Construieste blocul UBL pentru o parte (furnizor sau client). */
function partyXml(roleTag, p) {
  const tax = p.cui
    ? `\n      <cac:PartyTaxScheme>\n        <cbc:CompanyID>${esc(roCui(p.cui))}</cbc:CompanyID>\n        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>\n      </cac:PartyTaxScheme>`
    : '';
  const legalId = p.cui ? `\n        <cbc:CompanyID>${esc(p.regCom || roCui(p.cui))}</cbc:CompanyID>` : '';
  const county = p.judet ? `\n        <cbc:CountrySubentity>${esc(p.judet)}</cbc:CountrySubentity>` : '';
  return `  <cac:${roleTag}>
    <cac:Party>
      <cac:PostalAddress>
        <cbc:StreetName>${esc(p.adresa || '-')}</cbc:StreetName>
        <cbc:CityName>${esc(p.oras || '-')}</cbc:CityName>${county}
        <cac:Country><cbc:IdentificationCode>${esc(p.tara || 'RO')}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>${tax}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(p.name || '-')}</cbc:RegistrationName>${legalId}
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:${roleTag}>`;
}

/** Returneaza blocurile furnizor/client; daca invert=true, partenerul e furnizorul. */
function partyBlocks(company, entry, partners, invert) {
  const pinfo = (entry.partenerCui && partners && partners[entry.partenerCui.replace(/^ro/i, '')]) || {};
  const own = { cui: company.cui, name: company.nume, adresa: company.adresa, oras: company.oras, judet: company.judet, regCom: company.regCom, tara: 'RO' };
  const other = { cui: entry.partenerCui, name: pinfo.den || entry.partener || 'Partener', adresa: pinfo.adresa, oras: pinfo.oras, judet: pinfo.judet, tara: pinfo.tara };
  const sup = invert ? other : own;
  const cus = invert ? own : other;
  return { supplier: partyXml('AccountingSupplierParty', sup), customer: partyXml('AccountingCustomerParty', cus) };
}

/** Sumele (pozitive) pentru o factura storno: vanzare sau cumparare. */
function creditAmounts(entry) {
  if (entry.tip === 'factura_storno_cumparare') {
    let baza = 0; let tva = 0;
    for (const l of entry.lines) {
      if (l.debit === '4426') tva = round2(tva + l.suma);
      else if (l.debit !== '4427') baza = round2(baza + l.suma);
    }
    baza = Math.abs(baza); tva = Math.abs(tva);
    return { baza, tva, cota: baza ? Math.round((tva / baza) * 100) : 0 };
  }
  const a = invoiceAmounts(entry);
  return { baza: Math.abs(a.baza), tva: Math.abs(a.tva), cota: a.cota };
}

/** Genereaza o nota de credit UBL (CreditNote 381) pentru o factura storno. */
function eFacturaCreditNoteUBL(company, entry, partners) {
  const cur = 'RON';
  const purchase = entry.tip === 'factura_storno_cumparare';
  const a = creditAmounts(entry);
  const baza = a.baza;
  const tva = a.tva;
  const total = round2(baza + tva);
  const cota = a.cota;
  const id = entry.document || entry.id;
  const refFactura = entry.refFactura || entry.document || id;
  const { supplier, customer } = partyBlocks(company, entry, partners, purchase);
  return `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1</cbc:CustomizationID>
  <cbc:ID>${esc(id)}</cbc:ID>
  <cbc:IssueDate>${esc(entry.data)}</cbc:IssueDate>
  <cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${esc(refFactura)}</cbc:ID>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
${supplier}
${customer}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${cur}">${num2(tva)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${cur}">${num2(baza)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${cur}">${num2(tva)}</cbc:TaxAmount>
      <cac:TaxCategory>
${taxCategoryXml(cota, false, '        ')}
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${cur}">${num2(baza)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${cur}">${num2(baza)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${cur}">${num2(total)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${cur}">${num2(total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:CreditNoteLine>
    <cbc:ID>1</cbc:ID>
    <cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity>
    <cbc:LineExtensionAmount currencyID="${cur}">${num2(baza)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>Stornare conform documentului</cbc:Name>
      <cac:ClassifiedTaxCategory>
${taxCategoryXml(cota, false, '        ')}
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${cur}">${num2(baza)}</cbc:PriceAmount></cac:Price>
  </cac:CreditNoteLine>
</CreditNote>
`;
}

// ─────────────── Parsare UBL pentru factura primita (import din SPV) ───────────────
function between(xml, openTag, closeTag) {
  const i = xml.indexOf(openTag);
  if (i < 0) return '';
  const j = xml.indexOf(closeTag, i);
  return j < 0 ? '' : xml.slice(i + openTag.length, j);
}
function firstTag(xml, tag) {
  const m = String(xml).match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].trim() : '';
}
function numOf(s) { const n = parseFloat(String(s).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; }

/** Extrage campurile principale dintr-un document UBL primit (Invoice sau CreditNote). */
function parseUblInvoice(xmlStr) {
  const isCreditNote = /<CreditNote[\s>]/.test(xmlStr);
  const supplierBlock = between(xmlStr, '<cac:AccountingSupplierParty>', '</cac:AccountingSupplierParty>');
  const supplierName = firstTag(supplierBlock, 'cbc:RegistrationName');
  const taxBlock = between(supplierBlock, '<cac:PartyTaxScheme>', '</cac:PartyTaxScheme>');
  let cui = firstTag(taxBlock, 'cbc:CompanyID') || firstTag(supplierBlock, 'cbc:CompanyID');
  cui = String(cui).replace(/^ro/i, '').replace(/\D/g, '');
  const id = firstTag(xmlStr, 'cbc:ID');
  const data = firstTag(xmlStr, 'cbc:IssueDate');
  const baza = numOf(firstTag(xmlStr, 'cbc:TaxExclusiveAmount'));
  const taxTotal = between(xmlStr, '<cac:TaxTotal>', '</cac:TaxTotal>');
  const tva = numOf(firstTag(taxTotal, 'cbc:TaxAmount'));
  const total = numOf(firstTag(xmlStr, 'cbc:PayableAmount') || firstTag(xmlStr, 'cbc:TaxInclusiveAmount'));
  const cota = numOf(firstTag(xmlStr, 'cbc:Percent')) || (baza > 0 ? Math.round((tva / baza) * 100) : 21);
  const ref = firstTag(between(xmlStr, '<cac:BillingReference>', '</cac:BillingReference>'), 'cbc:ID');
  return {
    suggestedType: isCreditNote ? 'factura_storno_cumparare' : 'factura_cumparare_marfuri',
    fields: {
      data, document: id, partener: supplierName, cuiPartener: cui ? 'RO' + cui : '',
      refFactura: ref || '', baza: round2(baza), tva: round2(tva), cota,
      suma: round2(total || baza + tva), brut: null,
    },
    cuis: cui ? [cui] : [],
  };
}

// D390 VIES — declaratia recapitulativa pentru operatiuni intracomunitare
/** D390 VIES — recapitulativ intracomunitar pe schema OFICIALA v3: radacina cu identificare
 *  + declarant, <rezumat> (bazele pe tip de operatiune, in lei intregi) si cate o <operatie>
 *  per partener (tip L/A/P/S/T/R, tara + cod operator fara prefixul de tara). */
function d390Xml(company, period, d, who) {
  const { an, luna } = ym(period);
  const lei = (v) => String(Math.round(Number(v) || 0));
  const w = who && who.nume ? who : { nume: 'Administrator', prenume: '-', functie: 'Administrator' };
  const adresa = [company.adresa, company.oras, company.judet].filter(Boolean).join(', ');
  const rows = (d.rows || []).map((r) => {
    const tara = r.tara || String(r.cui || '').slice(0, 2);
    const codO = String(r.cui || '').replace(new RegExp('^' + tara, 'i'), '');
    return `  <operatie tip="${esc(r.cod)}" tara="${esc(tara)}" codO="${esc(codO)}" denO="${esc(r.denumire || '-')}" baza="${lei(r.baza)}"/>`;
  }).join('\n');
  const bazaL = lei(d.totalL); const bazaA = lei(d.totalA);
  const totalBaza = Math.round(d.totalL || 0) + Math.round(d.totalA || 0);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- D390 VIES v3 generat de Contabo. Verificare oficiala: scripts/valideaza-duk.sh D390 fisier.xml -->
<declaratie390 xmlns="mfp:anaf:dgti:d390:declaratie:v3"
  luna="${esc(luna)}" an="${esc(an)}" d_rec="0"
  nume_declar="${esc(w.nume)}" prenume_declar="${esc(w.prenume || '-')}" functie_declar="${esc(w.functie || 'Administrator')}"
  cui="${esc(String(company.cui).replace(/^ro/i, ''))}" den="${esc(company.nume)}" adresa="${esc(adresa || '-')}"
  totalPlata_A="${lei(totalBaza + (d.nr || 0))}">
  <rezumat nr_pag="1" nrOPI="${d.nr || 0}" bazaL="${bazaL}" bazaT="0" bazaA="${bazaA}" bazaP="0" bazaS="0" bazaR="0" total_baza="${lei(totalBaza)}"/>
${rows}
</declaratie390>
`;
}

// D100 — declaratia privind obligatiile de plata la bugetul de stat pe schema OFICIALA v2
// (aici: impozitul pe veniturile microintreprinderilor, trimestrial — cod obligatie 620).
function d100Xml(company, period, d, who) {
  const { an, luna } = ym(period);
  const lei = (v) => String(Math.round(Number(v) || 0));
  const w = who && who.nume ? who : { nume: 'Administrator', prenume: '-', functie: 'Administrator' };
  const adresa = [company.adresa, company.oras, company.judet].filter(Boolean).join(', ');
  // scadenta: 25 a lunii urmatoare perioadei (format romanesc ZZ.LL.AAAA)
  const next = Number(luna) === 12 ? { l: 1, a: Number(an) + 1 } : { l: Number(luna) + 1, a: Number(an) };
  const scadenta = '25.' + String(next.l).padStart(2, '0') + '.' + next.a;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- D100 v2 generat de Contabo. Verificare oficiala: scripts/valideaza-duk.sh D100 fisier.xml -->
<declaratie100 xmlns="mfp:anaf:dgti:d100:declaratie:v2"
  luna="${esc(luna)}" an="${esc(an)}" d_anulare="0"
  nume_declar="${esc(w.nume)}" prenume_declar="${esc(w.prenume || '-')}" functie_declar="${esc(w.functie || 'Administrator')}"
  cui="${esc(String(company.cui).replace(/^ro/i, ''))}" den="${esc(company.nume)}" adresa="${esc(adresa || '-')}"
  totalPlata_A="${lei(Math.round(d.impozit || 0) * 2)}">
  <obligatie cod_oblig="620" cod_bugetar="20A031800" scadenta="${scadenta}" nr_evid="${nrEvidPlata('620', luna, an)}"
    suma_dat="${lei(d.impozit)}" suma_plata="${lei(d.impozit)}"/>
</declaratie100>
`;
}

// Intrastat — declaratia statistica lunara pentru comertul intra-UE cu bunuri.
// Se depune la INS (aplicatia Intrastat online / www.intrastat.ro), NU la ANAF.
function intrastatXml(company, period, d) {
  const { an, luna } = ym(period);
  const row = (r) => `    <articol codNC="${esc(r.codNC)}" tara="${esc(r.tara)}" natura="${esc(r.natura || '11')}"`
    + ` conditie="${esc(r.conditie || '')}" valoare="${num2(r.valoare)}" masa_neta="${num2(r.masaNeta)}" nr_operatiuni="${r.nrop}"/>`;
  const intro = (d.rows || []).filter((r) => r.flux === 'introducere').map(row).join('\n');
  const exp = (d.rows || []).filter((r) => r.flux === 'expediere').map(row).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Intrastat generat de Contabo. A se verifica/incarca in aplicatia Intrastat online (INS) inainte de depunere — obligatoriu doar peste pragul anual. -->
<declaratieIntrastat cui="${esc(String(company.cui).replace(/^ro/i, ''))}" den="${esc(company.nume)}"
  luna="${esc(luna)}" an="${esc(an)}" total_introduceri="${num2(d.totalIntroduceri)}" total_expedieri="${num2(d.totalExpedieri)}">
  <introduceri total="${num2(d.totalIntroduceri)}" obligat="${d.obligatIntroduceri ? 'da' : 'nu'}">
${intro || '    <!-- fara introduceri -->'}
  </introduceri>
  <expedieri total="${num2(d.totalExpedieri)}" obligat="${d.obligatExpedieri ? 'da' : 'nu'}">
${exp || '    <!-- fara expedieri -->'}
  </expedieri>
</declaratieIntrastat>
`;
}

// D205 — impozit pe venit retinut la sursa, pe beneficiar, pe schema OFICIALA v2 (anuala:
// se depune in anul urmator celui raportat). Beneficiarii intra ca <benef> (rezidenti, CNP
// drept cifR), cu recapitulatia pe tip de venit in <sect_II>.
function d205Xml(company, year, d, who) {
  const lei = (v) => String(Math.round(Number(v) || 0));
  const w = who && who.nume ? who : { nume: 'Administrator', prenume: '-', functie: 'Administrator' };
  const adresa = [company.adresa, company.oras, company.judet].filter(Boolean).join(', ');
  // nomenclatorul tipurilor de venit (D205, OPANAF): 08 = dividende, 11 = premii, 04 = alte
  const tipCod = (t) => (/divid/i.test(t) ? '08' : /premi/i.test(t) ? '11' : '04');
  const rows = (d.rows || []).map((r, i) => {
    const tip = tipCod(r.tipVenit);
    const divid = tip === '08' ? ` divid_D="${lei(r.venitBrut)}" divid_P="${lei(r.venitBrut)}"` : '';
    return `  <benef id_inreg="${i + 1}" tip_venit1="${tip}" den1="${esc(r.beneficiar)}" cifR="${esc(r.cnp || '0')}" tip_plata="${tip === '08' ? '2' : '0'}" Rezid="1" baza1="${lei(r.venitBrut)}" imp1="${lei(r.impozit)}"${divid}/>`;
  }).join('\n');
  const sect2 = new Map();
  for (const r of d.rows || []) {
    const t = tipCod(r.tipVenit);
    const e = sect2.get(t) || { nr: 0, baza: 0, imp: 0 };
    e.nr += 1; e.baza += Math.round(r.venitBrut || 0); e.imp += Math.round(r.impozit || 0);
    sect2.set(t, e);
  }
  const sect2Xml = [...sect2.entries()].map(([t, e]) =>
    `  <sect_II tip_venit="${t}" nrben="${e.nr}" Tcastig="0" Tpierd="0" Tbaza="${lei(e.baza)}" Timp="${lei(e.imp)}" T_VB="0" T_GAR="0"/>`).join('\n');
  // suma de control (formula oficiala): doar campurile recapitulative din sect_II
  const sumaControl205 = [...sect2.values()].reduce((s, e) => s + e.nr + e.baza + e.imp, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- D205 v2 generat de Contabo. Verificare oficiala: scripts/valideaza-duk.sh D205 fisier.xml -->
<declaratie205 xmlns="mfp:anaf:dgti:d205:declaratie:v3"
  luna="12" an="${esc(String(year))}" d_rec="0" d_succ="0"
  nume_declar="${esc(w.nume)}" prenume_declar="${esc(w.prenume || '-')}" functie_declar="${esc(w.functie || 'Administrator')}"
  cui="${esc(String(company.cui).replace(/^ro/i, ''))}" den="${esc(company.nume)}" adresa="${esc(adresa || '-')}"
  totalPlata_A="${lei(sumaControl205)}">
${sect2Xml}
${rows}
</declaratie205>
`;
}

module.exports = {
  eFacturaUBL, eFacturaCreditNoteUBL, eFacturaXml, isEFacturaEligible, isSendable,
  umCode, d300Xml, d394Xml, d112Xml, d390Xml, d205Xml, d100Xml, intrastatXml, parseUblInvoice, SALES_TYPES, CREDIT_TYPES,
};
