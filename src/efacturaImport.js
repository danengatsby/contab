'use strict';

// Parser pentru e-Factura primita (UBL 2.1 / CIUS-RO): extrage furnizorul, numarul, data,
// bazele, TVA-ul si liniile dintr-un Invoice sau CreditNote, pentru a genera o factura de cumparare.

const { round2 } = require('./util');

function tag(xml, name) {
  // accepta prefix de namespace optional (cbc:, cac:)
  const m = String(xml).match(new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + name + '>'));
  return m ? m[1].trim() : '';
}
function tagAll(xml, name) {
  const out = []; const re = new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + name + '>', 'g');
  let m; while ((m = re.exec(String(xml)))) out.push(m[1]);
  return out;
}
function block(xml, name) {
  const m = String(xml).match(new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + name + '>'));
  return m ? m[1] : '';
}
function num(s) { const n = parseFloat(String(s).replace(/,/g, '.')); return Number.isFinite(n) ? round2(n) : 0; }
function unesc(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function party(b) {
  if (!b) return { nume: '', cui: '' };
  const legal = block(b, 'PartyLegalEntity');
  const taxScheme = block(b, 'PartyTaxScheme');
  const nume = unesc(tag(legal, 'RegistrationName') || tag(b, 'RegistrationName') || tag(b, 'Name'));
  // CUI: din PartyTaxScheme (TVA) sau PartyLegalEntity (CompanyID)
  let cui = tag(taxScheme, 'CompanyID') || tag(legal, 'CompanyID') || tag(b, 'EndpointID');
  cui = String(cui).replace(/^ro/i, '').replace(/\s/g, '');
  return { nume, cui };
}

/** @returns { tip, numar, data, scadenta, moneda, furnizor, client, baza, tva, total, cota, linii[] } */
function parseUBL(xmlStr) {
  const xml = String(xmlStr || '');
  if (!/<(?:\w+:)?(Invoice|CreditNote)[\s>]/.test(xml)) throw new Error('Fisierul nu este o e-Factura UBL (Invoice/CreditNote).');
  const isCredit = /<(?:\w+:)?CreditNote[\s>]/.test(xml);

  const numar = tag(xml, 'ID'); // primul <cbc:ID> = numarul facturii (CustomizationID are alt nume)
  const data = tag(xml, 'IssueDate');
  const scadenta = tag(xml, 'DueDate') || data;
  const moneda = tag(xml, 'DocumentCurrencyCode') || 'RON';
  const furnizor = party(block(xml, 'AccountingSupplierParty'));
  const client = party(block(xml, 'AccountingCustomerParty'));

  const mon = block(xml, 'LegalMonetaryTotal');
  const baza = num(tag(mon, 'TaxExclusiveAmount') || tag(mon, 'LineExtensionAmount'));
  const total = num(tag(mon, 'PayableAmount') || tag(mon, 'TaxInclusiveAmount'));
  const taxTotal = block(xml, 'TaxTotal');
  let tva = num(tag(taxTotal, 'TaxAmount'));
  if (!tva && total && baza) tva = round2(total - baza);
  const cota = baza > 0 && tva > 0 ? Math.round((tva / baza) * 100) : 0;

  const lineName = isCredit ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyName = isCredit ? 'CreditedQuantity' : 'InvoicedQuantity';
  const linii = tagAll(xml, lineName).map((ln) => {
    const item = block(ln, 'Item');
    const price = block(ln, 'Price');
    const cantitate = num(tag(ln, qtyName)) || 1;
    const valoare = num(tag(ln, 'LineExtensionAmount'));
    const pret = num(tag(price, 'PriceAmount')) || (cantitate ? round2(valoare / cantitate) : valoare);
    const lcota = num(tag(block(item, 'ClassifiedTaxCategory'), 'Percent'));
    return { nume: unesc(tag(item, 'Name') || 'Articol'), cantitate, pret, valoare, cota: lcota || cota };
  });

  return { tip: isCredit ? 'creditnote' : 'invoice', numar, data, scadenta, moneda, furnizor, client, baza, tva, total: total || round2(baza + tva), cota, linii };
}

module.exports = { parseUBL };
