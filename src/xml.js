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
  const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
  return m ? { an: m[1], luna: String(Number(m[2])) } : { an: String(new Date().getFullYear()), luna: '1' };
}

/** D300 — decont TVA (structura ANAF, valori principale). */
// Cod de rand D300 dupa cota (orientativ): 21% -> 1, 11% -> 2, 5% -> 3, scutit/0% -> 0
function rdCota(cota) { return cota === 21 ? '1' : cota === 11 ? '2' : cota === 5 ? '3' : '0'; }
/** Atributele declarantului (intocmitorului) — incluse doar cand datele exista. */
function declarant(who) {
  if (!who || !who.nume) return '';
  let a = ` nume_declar="${esc(who.nume)}"`;
  if (who.prenume) a += ` prenume_declar="${esc(who.prenume)}"`;
  if (who.functie) a += ` functie_declar="${esc(who.functie)}"`;
  return a;
}

function d300Xml(company, period, d, who) {
  const { an, luna } = ym(period);
  const randuri = (list, kind) => (list || []).map((c) =>
    `  <rand sectiune="${kind}" rd="${rdCota(c.cota)}" cota="${c.cota}" baza="${num2(c.baza)}" tva="${num2(c.tva)}"/>`).join('\n');
  const liv = randuri(d.coteV, 'livrari');
  const ach = randuri(d.coteC, 'achizitii');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- D300 (recapitulatie) generat de Contabo. A se valida cu DUKIntegrator / XSD ANAF curent inainte de depunere. -->
<declaratie300 xmlns="mfp:anaf:dgti:d300:declaratie:v3"
  cif="${esc(String(company.cui).replace(/^ro/i, ''))}" den="${esc(company.nume)}"
  luna="${esc(luna)}" an="${esc(an)}" sumactrl="0"${declarant(who)}>
  <livrari_taxabile baza="${num2(d.bazaV)}" tva="${num2(d.colectata)}">
${liv || '    <!-- fara livrari -->'}
  </livrari_taxabile>
  <achizitii_taxabile baza="${num2(d.bazaC)}" tva="${num2(d.deductibila)}">
${ach || '    <!-- fara achizitii -->'}
  </achizitii_taxabile>
  <tva_colectata>${num2(d.colectata)}</tva_colectata>
  <tva_deductibila>${num2(d.deductibila)}</tva_deductibila>
  <tva_de_plata>${num2(d.deplata)}</tva_de_plata>
  <tva_de_recuperat>${num2(d.derecuperat)}</tva_de_recuperat>
</declaratie300>
`;
}

/** D112 — declaratia privind contributiile sociale, impozitul si evidenta nominala (din statul de plata). */
function d112Xml(company, period, sp, who) {
  const { an, luna } = ym(period);
  const t = sp.totals;
  const asigurati = sp.rows.map((r) => `    <asigurat nume="${esc(r.nume)}" cnp="${esc(r.cnp)}" functie="${esc(r.functie)}" `
    + `venit_brut="${num2(r.brut)}" baza_cas="${num2(r.brut)}" cas="${num2(r.cas)}" baza_cass="${num2(r.brut)}" cass="${num2(r.cass)}" `
    + `baza_impozit="${num2(round2(r.brut - r.cas - r.cass - r.neimpozabil))}" impozit="${num2(r.impozit)}" venit_net="${num2(r.net)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- D112 (recapitulatie + evidenta nominala) generat de Contabo. A se valida cu DUKIntegrator / XSD ANAF curent inainte de depunere. -->
<declaratie112 xmlns="mfp:anaf:dgti:d112:declaratie:v1"
  cui="${esc(String(company.cui).replace(/^ro/i, ''))}" den="${esc(company.nume)}"
  luna="${esc(luna)}" an="${esc(an)}" nr_asigurati="${sp.rows.length}" tip_d="0"${declarant(who)}>
  <creante_fiscale>
    <total_salarii_brute>${num2(t.brut)}</total_salarii_brute>
    <CAS_asigurat>${num2(t.cas)}</CAS_asigurat>
    <CASS_asigurat>${num2(t.cass)}</CASS_asigurat>
    <impozit_salarii>${num2(t.impozit)}</impozit_salarii>
    <CAM_angajator>${num2(t.cam)}</CAM_angajator>
    <total_de_plata>${num2(t.totalBuget)}</total_de_plata>
  </creante_fiscale>
  <asigurati>
${asigurati}
  </asigurati>
</declaratie112>
`;
}

/** D394 — declaratie informativa (structura ANAF, agregare pe partener). */
function d394Xml(company, period, vj, who) {
  const { an, luna } = ym(period);
  const agg = (rows) => {
    const map = new Map();
    for (const r of rows) {
      const key = (r.cui || r.partener || '-').toUpperCase();
      const e = map.get(key) || { cui: r.cui || '', den: r.partener || '', baza: 0, tva: 0, nr: 0, cote: {} };
      e.baza = round2(e.baza + r.baza); e.tva = round2(e.tva + r.tva); e.nr += 1;
      const cota = r.baza > 0 && r.tva > 0 ? Math.round((r.tva / r.baza) * 100) : 0;
      e.cote[cota] = e.cote[cota] || { baza: 0, tva: 0 };
      e.cote[cota].baza = round2(e.cote[cota].baza + r.baza); e.cote[cota].tva = round2(e.cote[cota].tva + r.tva);
      if (!e.den && r.partener) e.den = r.partener;
      map.set(key, e);
    }
    return [...map.values()];
  };
  const part = (p) => {
    const cote = Object.keys(p.cote).sort((a, b) => b - a).map((c) =>
      `      <cota cota="${c}" baza="${num2(p.cote[c].baza)}" tva="${num2(p.cote[c].tva)}"/>`).join('\n');
    return `    <partener cui="${esc(p.cui)}" den="${esc(p.den)}" nr_facturi="${p.nr}" baza="${num2(p.baza)}" tva="${num2(p.tva)}">
${cote}
    </partener>`;
  };
  const liv = agg(vj.vanzari).map(part).join('\n');
  const ach = agg(vj.cumparari).map(part).join('\n');
  const cote = (list) => (list || []).map((c) => `    <rand cota="${c.cota}" baza="${num2(c.baza)}" tva="${num2(c.tva)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- D394 (recapitulatie) generat de Contabo. A se valida cu DUKIntegrator / XSD ANAF curent inainte de depunere. -->
<declaratie394 xmlns="mfp:anaf:dgti:d394:declaratie:v2"
  cui="${esc(String(company.cui).replace(/^ro/i, ''))}" den="${esc(company.nume)}"
  luna="${esc(luna)}" an="${esc(an)}"${declarant(who)}>
  <rezumat_cote>
    <livrari>
${cote(vj.coteV) || '      <!-- - -->'}
    </livrari>
    <achizitii>
${cote(vj.coteC) || '      <!-- - -->'}
    </achizitii>
  </rezumat_cote>
  <livrari total_baza="${num2(vj.totals.bazaV)}" total_tva="${num2(vj.totals.colectata)}">
${liv || '    <!-- fara livrari -->'}
  </livrari>
  <achizitii total_baza="${num2(vj.totals.bazaC)}" total_tva="${num2(vj.totals.deductibila)}">
${ach || '    <!-- fara achizitii -->'}
  </achizitii>
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
function d390Xml(company, period, d) {
  const { an, luna } = ym(period);
  const rows = (d.rows || []).map((r) =>
    `    <operatiune cod="${esc(r.cod)}" tara="${esc(r.tara || (r.cui || '').slice(0, 2))}" cod_operator="${esc(r.cui)}" denumire="${esc(r.denumire)}" baza="${num2(r.baza)}" nr_op="${r.nrop}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- D390 VIES (recapitulativ intracomunitar) generat de Contabo. A se valida cu DUKIntegrator / XSD ANAF curent inainte de depunere. -->
<declaratie390 xmlns="mfp:anaf:dgti:d390:declaratie:v1"
  cui="${esc(String(company.cui).replace(/^ro/i, ''))}" den="${esc(company.nume)}"
  luna="${esc(luna)}" an="${esc(an)}" total_livrari="${num2(d.totalL)}" total_achizitii="${num2(d.totalA)}" nr_operatori="${d.nr || 0}">
${rows || '    <!-- nicio operatiune intracomunitara in perioada -->'}
</declaratie390>`;
}

// D205 — impozit pe venit retinut la sursa, pe beneficiar
function d205Xml(company, year, d) {
  const rows = (d.rows || []).map((r) =>
    `    <beneficiar tip_venit="${esc(r.tipVenit)}" cnp="${esc(r.cnp)}" nume="${esc(r.beneficiar)}" venit_brut="${num2(r.venitBrut)}" impozit_retinut="${num2(r.impozit)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- D205 (impozit retinut la sursa) generat de Contabo. A se valida cu DUKIntegrator / XSD ANAF curent inainte de depunere. -->
<declaratie205 xmlns="mfp:anaf:dgti:d205:declaratie:v1"
  cui="${esc(String(company.cui).replace(/^ro/i, ''))}" den="${esc(company.nume)}" an="${esc(String(year))}"
  total_venit="${num2(d.totalBrut)}" total_impozit="${num2(d.totalImpozit)}" nr_beneficiari="${d.nr || 0}">
${rows || '    <!-- niciun venit cu retinere la sursa in an -->'}
</declaratie205>`;
}

module.exports = {
  eFacturaUBL, eFacturaCreditNoteUBL, eFacturaXml, isEFacturaEligible, isSendable,
  d300Xml, d394Xml, d112Xml, d390Xml, d205Xml, parseUblInvoice, SALES_TYPES, CREDIT_TYPES,
};
