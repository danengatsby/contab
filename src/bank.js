'use strict';

const { round2 } = require('./util');
const { parseRoNumber } = require('./extractor');
const { candidatesFor } = require('./matching');
const openItems = require('./openItems');

/** Imparte un rand CSV respectand ghilimelele. */
function splitCsvLine(line, delim) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === delim && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function detectDelim(text) {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n');
  return (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ';' : ',';
}

function parseDateRo(s) {
  let m = String(s).match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** Parseaza un extras CSV (cu sau fara antet). Returneaza tranzactii. */
function parseCsv(text) {
  const delim = detectDelim(text);
  const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => splitCsvLine(l, delim));
  if (!rows.length) return [];
  // gaseste randul de antet
  let headIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const j = rows[i].join('|').toLowerCase();
    if (/data|date/.test(j) && /(suma|amount|debit|credit|valoare)/.test(j)) { headIdx = i; break; }
  }
  const norm = (s) => s.toLowerCase();
  let cols = { data: 0, valueDate: -1, desc: 1, debit: -1, credit: -1, suma: -1, id: -1, balance: -1, currency: -1, iban: -1 };
  let start = 0;
  if (headIdx >= 0) {
    const h = rows[headIdx].map(norm);
    const find = (re) => h.findIndex((x) => re.test(x));
    cols = {
      data: find(/data|date/),
      valueDate: find(/data.*val|value.*date/),
      desc: find(/descri|detal|explica|referin|beneficiar|ordonator|partener|denumire/),
      debit: find(/debit|plati|iesiri/),
      credit: find(/credit|incasari|intrari/),
      suma: find(/^suma$|amount|valoare/),
      id: find(/id.*tranz|transaction.*id|referin.*banc|bank.*ref|ntry.*ref/),
      balance: find(/^sold|sold.*curent|balance/),
      currency: find(/moned|currency|ccy/),
      iban: find(/^iban$|cont.*iban|account.*iban/),
    };
    start = headIdx + 1;
  }
  const txns = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const data = parseDateRo(r[cols.data >= 0 ? cols.data : 0] || '');
    if (!data) continue;
    const descParts = [];
    if (cols.desc >= 0 && r[cols.desc]) descParts.push(r[cols.desc]);
    else r.forEach((c, idx) => { if (idx !== cols.data && idx !== cols.debit && idx !== cols.credit && idx !== cols.suma && /[a-zA-Z]/.test(c)) descParts.push(c); });
    const descriere = descParts.join(' ').trim();
    let suma = 0; let sens = '';
    const deb = cols.debit >= 0 ? parseRoNumber(r[cols.debit]) : null;
    const cre = cols.credit >= 0 ? parseRoNumber(r[cols.credit]) : null;
    if (deb || cre) {
      if (cre && cre > 0) { suma = cre; sens = 'in'; } else if (deb && deb > 0) { suma = deb; sens = 'out'; } else continue;
    } else {
      const v = parseRoNumber(r[cols.suma >= 0 ? cols.suma : r.length - 1]);
      if (v == null || v === 0) continue;
      suma = Math.abs(v); sens = v >= 0 ? 'in' : 'out';
    }
    const valueDate = cols.valueDate >= 0 ? parseDateRo(r[cols.valueDate] || '') : '';
    const balance = cols.balance >= 0 ? parseRoNumber(r[cols.balance]) : null;
    txns.push({ data, valueDate: valueDate || data, descriere, suma: round2(suma), sens,
      externalId: cols.id >= 0 ? String(r[cols.id] || '').trim() : '',
      ...(Number.isFinite(balance) ? { balance: round2(balance) } : {}),
      currency: cols.currency >= 0 ? String(r[cols.currency] || '').trim().toUpperCase() : '',
      iban: cols.iban >= 0 ? String(r[cols.iban] || '').replace(/\s+/g, '').toUpperCase() : '' });
  }
  return txns;
}

/** Parseaza un extras MT940 (tag-uri :61: si :86:). */
function parseMt940(text) {
  const lines = text.split(/\r?\n/);
  const txns = []; let cur = null;
  for (const line of lines) {
    if (line.startsWith(':61:')) {
      if (cur) txns.push(cur);
      const body = line.slice(4);
      const m = body.match(/^(\d{6})(\d{4})?(R?[CD])([0-9.,]+)/);
      if (!m) { cur = null; continue; }
      const yy = m[1].slice(0, 2); const mm = m[1].slice(2, 4); const dd = m[1].slice(4, 6);
      const sens = /C/.test(m[3]) && !/RC/.test(m[3]) ? 'in' : (/D/.test(m[3]) ? 'out' : 'in');
      const rest = body.slice(m[0].length);
      const ref = (rest.match(/\/\/([^\s]+)/) || rest.match(/N[A-Z0-9]{3}([^\s/]{1,32})/) || [])[1] || '';
      cur = { data: `20${yy}-${mm}-${dd}`, valueDate: `20${yy}-${mm}-${dd}`, sens,
        suma: round2(parseRoNumber(m[4]) || 0), descriere: '', externalId: ref.trim() };
    } else if (line.startsWith(':86:') && cur) {
      cur.descriere += line.slice(4).replace(/\?\d{2}/g, ' ').trim() + ' ';
    } else if (cur && line && !line.startsWith(':')) {
      cur.descriere += line.trim() + ' ';
    }
  }
  if (cur) txns.push(cur);
  return txns.map((t) => ({ ...t, descriere: t.descriere.trim() }));
}

// ── CAMT.053 (ISO 20022, XML): extrasul modern SEPA. Parsare namespace-agnostica prin regex,
// exact ca la e-Factura UBL (fara dependenta de un parser XML). ──
function xmlUnesc(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function xmlTag(xml, name) {
  const m = String(xml).match(new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + name + '>'));
  return m ? m[1] : '';
}
function xmlTagAll(xml, name) {
  const out = []; const re = new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + name + '>', 'g');
  let m; while ((m = re.exec(String(xml))) !== null) out.push(m[1]);
  return out;
}

function xmlNode(xml, name) {
  const m = String(xml).match(new RegExp('<(?:\\w+:)?' + name + '([^>]*)>([\\s\\S]*?)</(?:\\w+:)?' + name + '>'));
  return m ? { attrs: m[1] || '', value: m[2] || '' } : { attrs: '', value: '' };
}

function amountNode(xml) {
  const n = xmlNode(xml, 'Amt');
  const ccy = (n.attrs.match(/\bCcy=["']([A-Za-z]{3})["']/i) || [])[1] || '';
  return { amount: round2(parseFloat(String(n.value).replace(/,/g, '.')) || 0), currency: ccy.toUpperCase() };
}

function camtEntries(stmtXml) {
  const txns = [];
  for (const ntry of xmlTagAll(stmtXml, 'Ntry')) {
    const amt = amountNode(ntry); const suma = amt.amount;
    if (!(suma > 0)) continue;
    let sens = xmlTag(ntry, 'CdtDbtInd').toUpperCase() === 'DBIT' ? 'out' : 'in';
    if (/^(true|1)$/i.test(xmlTag(ntry, 'RvslInd').trim())) sens = sens === 'in' ? 'out' : 'in';
    const booking = xmlTag(ntry, 'BookgDt'); const value = xmlTag(ntry, 'ValDt');
    const data = String(xmlTag(booking, 'Dt') || xmlTag(booking, 'DtTm') || xmlTag(value, 'Dt') || xmlTag(value, 'DtTm')).slice(0, 10);
    const valueDate = String(xmlTag(value, 'Dt') || xmlTag(value, 'DtTm') || data).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) continue;
    const parts = [];
    for (const u of xmlTagAll(ntry, 'Ustrd')) parts.push(xmlUnesc(u));
    for (const nm of xmlTagAll(xmlTag(ntry, 'RltdPties'), 'Nm')) parts.push(xmlUnesc(nm));
    const addl = xmlTag(ntry, 'AddtlNtryInf'); if (addl) parts.push(xmlUnesc(addl));
    const descriere = [...new Set(parts.map((s) => s.trim()).filter(Boolean))].join(' ').replace(/\s+/g, ' ').trim();
    const refs = ['AcctSvcrRef', 'NtryRef', 'TxId', 'EndToEndId', 'InstrId'].map((k) => xmlUnesc(xmlTag(ntry, k)).trim())
      .filter((x) => x && !/^NOTPROVIDED$/i.test(x));
    const related = xmlTag(ntry, 'RltdPties');
    const partyIban = xmlTag(related, 'IBAN').replace(/\s+/g, '').toUpperCase();
    txns.push({ data, valueDate, descriere, suma, sens, currency: amt.currency,
      externalId: refs[0] || '', bankReference: refs.join('|').slice(0, 300), counterpartyIban: partyIban });
  }
  return txns;
}

/** Parseaza un extras CAMT.053 (bank-to-customer statement). O tranzactie = un <Ntry>. */
function parseCamt(xml) {
  return camtEntries(xml);
}

function parseStatement(text) {
  if (/<(?:\w+:)?BkToCstmrStmt[\s>]|camt\.053/i.test(text)) return parseCamt(text);
  return /:61:/.test(text) ? parseMt940(text) : parseCsv(text);
}

function periodBounds(txns) {
  const dates = txns.map((t) => t.data).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
  return { periodFrom: dates[0] || '', periodTo: dates[dates.length - 1] || '' };
}

function mtBalance(block, tag) {
  const raw = ((block.match(new RegExp('^:' + tag + ':([^\\r\\n]+)', 'm')) || [])[1] || '').trim();
  const m = raw.match(/^([CD])\d{6}([A-Z]{3})([0-9.,]+)/i); if (!m) return null;
  const q = round2(parseRoNumber(m[3]) || 0);
  return { amount: m[1].toUpperCase() === 'D' ? -q : q, currency: m[2].toUpperCase() };
}

function parseMt940Detailed(text) {
  const blocks = String(text).match(/:20:[\s\S]*?(?=\r?\n:20:|$)/g) || [String(text)];
  return blocks.map((block, index) => {
    const transactions = parseMt940(block); const bounds = periodBounds(transactions);
    const opening = mtBalance(block, '60F') || mtBalance(block, '60M');
    const closing = mtBalance(block, '62F') || mtBalance(block, '62M');
    const account = ((block.match(/^:25:([^\r\n]+)/m) || [])[1] || '').trim();
    const iban = (account.match(/[A-Z]{2}\d{2}[A-Z0-9]{11,30}/i) || [])[0] || account;
    return { format: 'MT940', statementExternalId: ((block.match(/^:28C:([^\r\n]+)/m) || [])[1] || '').trim() || 'MT940-' + (index + 1),
      iban: iban.replace(/\s+/g, '').toUpperCase(), currency: (opening && opening.currency) || (closing && closing.currency) || '',
      openingBalance: opening ? opening.amount : null, closingBalance: closing ? closing.amount : null,
      ...bounds, transactions };
  });
}

function camtBalance(stmt, wanted) {
  for (const bal of xmlTagAll(stmt, 'Bal')) {
    const type = xmlTag(xmlTag(bal, 'Tp'), 'Cd').trim().toUpperCase();
    if (!wanted.includes(type)) continue;
    const a = amountNode(bal); const ind = xmlTag(bal, 'CdtDbtInd').trim().toUpperCase();
    return { amount: round2(ind === 'DBIT' ? -a.amount : a.amount), currency: a.currency,
      date: String(xmlTag(xmlTag(bal, 'Dt'), 'Dt') || xmlTag(bal, 'Dt')).slice(0, 10) };
  }
  return null;
}

function parseCamtDetailed(xml) {
  const blocks = xmlTagAll(xmlTag(xml, 'BkToCstmrStmt') || xml, 'Stmt');
  return (blocks.length ? blocks : [xml]).map((stmt, index) => {
    const transactions = camtEntries(stmt); const acct = xmlTag(stmt, 'Acct'); const bounds = periodBounds(transactions);
    const opening = camtBalance(stmt, ['OPBD', 'PRCD']); const closing = camtBalance(stmt, ['CLBD', 'ITBD']);
    const range = xmlTag(stmt, 'FrToDt');
    const from = String(xmlTag(range, 'FrDtTm') || xmlTag(range, 'FrDt')).slice(0, 10);
    const to = String(xmlTag(range, 'ToDtTm') || xmlTag(range, 'ToDt')).slice(0, 10);
    return { format: 'CAMT.053', statementExternalId: xmlUnesc(xmlTag(stmt, 'Id')).trim() || 'CAMT-' + (index + 1),
      iban: xmlTag(acct, 'IBAN').replace(/\s+/g, '').toUpperCase(),
      currency: (xmlTag(acct, 'Ccy') || (opening && opening.currency) || (closing && closing.currency) || (transactions[0] && transactions[0].currency) || '').trim().toUpperCase(),
      openingBalance: opening ? opening.amount : null, closingBalance: closing ? closing.amount : null,
      periodFrom: from || (opening && opening.date) || bounds.periodFrom, periodTo: to || (closing && closing.date) || bounds.periodTo,
      transactions };
  });
}

function labeledAmount(text, re) {
  for (const line of String(text).split(/\r?\n/)) if (re.test(line)) {
    const nums = line.match(/[-+]?\d[\d .]*(?:[,.]\d+)?/g) || [];
    for (let i = nums.length - 1; i >= 0; i -= 1) { const q = parseRoNumber(nums[i]); if (Number.isFinite(q)) return round2(q); }
  }
  return null;
}

function parseCsvDetailed(text) {
  const transactions = parseCsv(text); const bounds = periodBounds(transactions);
  const withBalance = transactions.filter((t) => Number.isFinite(t.balance));
  let openingBalance = labeledAmount(text, /sold\s*(initial|precedent)|opening\s*balance/i);
  let closingBalance = labeledAmount(text, /sold\s*(final|curent)|closing\s*balance/i);
  if (withBalance.length) {
    if (!Number.isFinite(openingBalance)) openingBalance = round2(withBalance[0].balance - (withBalance[0].sens === 'out' ? -withBalance[0].suma : withBalance[0].suma));
    if (!Number.isFinite(closingBalance)) closingBalance = withBalance[withBalance.length - 1].balance;
  }
  const iban = ((String(text).match(/\b[A-Z]{2}\d{2}[A-Z0-9 ]{11,34}\b/i) || [])[0] || (transactions.find((t) => t.iban) || {}).iban || '').replace(/\s+/g, '').toUpperCase();
  const currency = ((transactions.find((t) => t.currency) || {}).currency || (String(text).match(/\b(RON|EUR|USD|GBP|CHF|HUF|PLN)\b/i) || [])[1] || '').toUpperCase();
  return [{ format: 'CSV', statementExternalId: '', iban, currency, openingBalance, closingBalance, ...bounds, transactions }];
}

/** Structura completa: un fisier poate contine mai multe extrase/IBAN-uri. */
function parseDetailed(text) {
  if (/<(?:\w+:)?BkToCstmrStmt[\s>]|camt\.053/i.test(text)) return parseCamtDetailed(text);
  if (/:61:/.test(text)) return parseMt940Detailed(text);
  return parseCsvDetailed(text);
}

/** Cauta partenerul potrivit dupa CUI sau denumire in descriere. */
function matchPartner(db, descriere) {
  const D = String(descriere).toUpperCase();
  for (const cui of Object.keys(db.partners || {})) {
    if (D.replace(/\D/g, '').includes(cui) || D.includes('RO' + cui)) return db.partners[cui];
  }
  const names = new Map();
  for (const p of Object.values(db.partners || {})) if (p.den) names.set(p.den.toUpperCase(), { den: p.den, cui: p.cui });
  for (const e of db.entries) if (e.partener) names.set(e.partener.toUpperCase(), { den: e.partener, cui: e.partenerCui ? e.partenerCui.replace(/^ro/i, '') : '' });
  for (const [up, info] of names) if (up.length > 3 && D.includes(up)) return info;
  return null;
}

/** Construieste o sugestie de inregistrare pentru o tranzactie bancara. */
function suggest(db, t) {
  const lc = t.descriere.toLowerCase();
  const bankAccount = String(t.currency || '').toUpperCase() && String(t.currency).toUpperCase() !== 'RON' ? '5124' : '5121';
  const bankFields = { cont: bankAccount, analitic: t.iban || '' };
  if (/comision|spez|taxa adm|cost adm/.test(lc)) {
    return { tip: 'comision_bancar', fields: { data: t.data, document: '', suma: t.suma, ...bankFields } };
  }
  if (/dobanda|dobânda/.test(lc) && t.sens === 'out') {
    return { tip: 'dobanda_bancara', fields: { data: t.data, document: '', suma: t.suma, ...bankFields } };
  }
  const p = matchPartner(db, t.descriere);
  const partener = (p && p.den) || t.descriere.slice(0, 40);
  const cui = p && p.cui ? 'RO' + String(p.cui).replace(/^ro/i, '') : '';
  if (t.sens === 'in') {
    return { tip: 'incasare_client', matched: !!p, fields: { data: t.data, partener, cuiPartener: cui, document: '', suma: t.suma, ...bankFields } };
  }
  return { tip: 'plata_furnizor', matched: !!p, fields: { data: t.data, partener, cuiPartener: cui, document: '', suma: t.suma, ...bankFields, contFz: '401' } };
}

// Index al facturilor DESCHISE (sold neachitat) pe SENS (creanta = de incasat / datorie = de
// platit) si pe cheie de partener (denumire + CUI), calculat o data din reconcilierea fiselor.
// Alimenteaza potrivirea liniei de extras cu factura pe care o stinge.
// Cheia era codul de cont (4111/401), deci o plata care stingea o factura de imobilizari (404)
// sau una nesosita (408) nu gasea nimic de potrivit.
function openInvoiceIndex(db) {
  const idx = { creanta: new Map(), datorie: new Map() };
  for (const d of openItems.registry(db, null).openDocuments) {
    const m = idx[d.sens]; if (!m) continue;
    const item = { id: d.id, doc: d.document, data: d.data, dueDate: d.dueDate, suma: d.residual };
    const add = (k) => { if (k) m.set(k, (m.get(k) || []).concat(item)); };
    add(d.partener && d.partener.toUpperCase().trim());
    add(d.cui && String(d.cui).replace(/^ro/i, '').trim());
  }
  return idx;
}

function suggestTransactions(db, txns) {
  const openIdx = openInvoiceIndex(db);
  return txns.map((t, i) => {
    const sug = suggest(db, t);
    // potriveste incasarea/plata cu factura deschisa a partenerului (exacta -> agregata -> partiala)
    if (sug.matched && (sug.tip === 'incasare_client' || sug.tip === 'plata_furnizor')) {
      const sens = sug.tip === 'incasare_client' ? 'creanta' : 'datorie';
      const cui = String(sug.fields.cuiPartener || '').replace(/^ro/i, '').trim();
      const den = String(sug.fields.partener || '').toUpperCase().trim();
      const open = openIdx[sens].get(cui) || openIdx[sens].get(den) || [];
      const m = candidatesFor(open, t.suma);
      sug.potrivire = m;
      // legatura de decontare (punctaj): id-urile facturilor stinse, propuse spre confirmare la import
      if (m.facturi.length) sug.stinge = m.facturi.map((fa) => fa.id).filter(Boolean);
      // pre-completeaza referinta documentului DOAR pe potrivirea sigura (exacta); restul le decide contabilul
      if (m.tip === 'exacta' && m.facturi[0] && m.facturi[0].doc && !sug.fields.document) sug.fields.document = m.facturi[0].doc;
    }
    return Object.assign({ idx: i, data: t.data, descriere: t.descriere, suma: t.suma, sens: t.sens }, sug);
  });
}

function parseAndSuggest(db, text) { return suggestTransactions(db, parseStatement(text)); }

module.exports = { parseStatement, parseDetailed, parseCsv, parseMt940, parseCamt, parseCamtDetailed, parseMt940Detailed,
  parseCsvDetailed, parseAndSuggest, suggestTransactions, suggest, matchPartner, openInvoiceIndex };
