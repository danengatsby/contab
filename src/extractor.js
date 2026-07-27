'use strict';

const PDFParser = require('pdf2json');
const { round2 } = require('./util');
const fiscal = require('./fiscal');

/**
 * Octetii PDF-ului, garantat intr-un ArrayBuffer PROPRIU (byteOffset 0, exact lungimea lui).
 *
 * De ce: `fs.readFileSync` aloca din POOL-ul de Buffere pentru fisiere sub 4 KB
 * (`Buffer.poolSize >>> 1`), deci intoarce o VEDERE intr-un ArrayBuffer de 8 KB partajat cu
 * alte alocari — `byteOffset` != 0. pdf2json (pdf.js) citeste ArrayBuffer-ul SUBIACENT intreg,
 * ignorand `byteOffset`/`length`: parseaza octeti straini si iese cu „Invalid XRef stream header".
 * Iar `extractText` inghite eroarea prin proiectare (extragerea de text e calea de rezerva), deci
 * defectul era TACUT — orice PDF incarcat sub 4 KB pur si simplu nu dadea text, fara niciun semn.
 * Masurat: 3.344 si 3.403 octeti -> zero text; 4.742 octeti (peste prag, byteOffset 0) -> corect.
 *
 * Copiem doar cand e nevoie: peste prag Buffer-ul are deja ArrayBuffer propriu, deci zero cost.
 */
function ownBytes(buffer) {
  if (!buffer || typeof buffer.byteLength !== 'number') return buffer;
  const propriu = buffer.byteOffset === 0 && buffer.buffer && buffer.buffer.byteLength === buffer.byteLength;
  if (propriu) return buffer;
  const copie = new Uint8Array(buffer.byteLength);
  copie.set(buffer);
  return copie;
}

/** Extrage textul dintr-un PDF cu pdf2json (motor pdf.js mentinut) - reconstruieste randurile
 *  dupa pozitie (grupare pe y, ordonare pe x), ce tine eticheta si valoarea pe acelasi rand
 *  (util pentru euristicile de mai jos). Consolidat pe pdf2json, cu pdf-parse (nementinut) scos:
 *  masurat pe PDF-uri reale, pdf2json extrage text comparabil-sau-mai-mult (0 erori pe 9 fisiere,
 *  overlap de tokenuri 92-100%) si da paritate de campuri pe continut de factura. Intoarce '' la
 *  orice esec - extragerea de text e calea de REZERVA (fara AI): un esec cade elegant pe completare
 *  manuala, deci nu trebuie sa arunce. */
function extractText(buffer) {
  return new Promise((resolve) => {
    const p = new PDFParser(null, 1);
    p.on('pdfParser_dataError', () => resolve(''));
    p.on('pdfParser_dataReady', (data) => {
      const out = [];
      for (const pg of (data.Pages || [])) {
        const rows = {};
        for (const t of (pg.Texts || [])) {
          const y = Math.round(t.y * 2) / 2;
          const s = (t.R || []).map((r) => { try { return decodeURIComponent(r.T); } catch (_) { return r.T; } }).join('');
          (rows[y] = rows[y] || []).push({ x: t.x, s });
        }
        for (const y of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
          out.push(rows[y].sort((a, b) => a.x - b.x).map((o) => o.s).join(' '));
        }
      }
      const txt = out.join('\n');
      resolve(txt.trim() ? txt : '');
    });
    try { p.parseBuffer(ownBytes(buffer)); } catch (_) { resolve(''); }
  });
}

/** Parseaza un numar din text in format romanesc (1.234,56) sau international (1,234.56). */
function parseRoNumber(s) {
  if (s == null) return null;
  let t = String(s).trim().replace(/\s/g, '').replace(/lei|ron/gi, '');
  if (!t) return null;
  const hasDot = t.includes('.');
  const hasComma = t.includes(',');
  if (hasDot && hasComma) {
    // separatorul zecimal este ultimul aparut
    if (t.lastIndexOf(',') > t.lastIndexOf('.')) {
      t = t.replace(/\./g, '').replace(',', '.'); // 1.234,56
    } else {
      t = t.replace(/,/g, ''); // 1,234.56
    }
  } else if (hasComma) {
    // o singura virgula -> zecimala daca are <=2 cifre dupa
    const parts = t.split(',');
    if (parts.length === 2 && parts[1].length <= 2) t = parts.join('.');
    else t = t.replace(/,/g, '');
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/** Cauta o valoare numerica dupa o eticheta (ex: "Total", "TVA"). */
function findAmountAfter(text, labels) {
  for (const label of labels) {
    const re = new RegExp(label + '[^0-9\\-]{0,20}(-?[0-9][0-9.,\\s]*[0-9]|-?[0-9])', 'i');
    const m = text.match(re);
    if (m) {
      const n = parseRoNumber(m[1]);
      if (n != null) return n;
    }
  }
  return null;
}

function extractDate(text) {
  // dd.mm.yyyy / dd/mm/yyyy / dd-mm-yyyy
  let m = text.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\b/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    return `${m[3]}-${mm}-${dd}`;
  }
  // yyyy-mm-dd
  m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}

function extractCUIs(text) {
  const set = new Set();
  const re = /\b(?:RO\s*)?(\d{6,10})\b/gi;
  // restrange la contextul CUI/CIF
  const ctx = text.match(/(?:C\.?U\.?I\.?|C\.?I\.?F\.?|cod\s+fiscal|cod\s+de\s+inregistrare)[^0-9]{0,12}(RO\s*)?\d{6,10}/gi) || [];
  for (const c of ctx) {
    const m = c.match(/(\d{6,10})/);
    if (m) set.add(m[1]);
  }
  if (set.size === 0) {
    let m;
    while ((m = re.exec(text)) !== null) set.add(m[1]);
  }
  return [...set];
}

function guessCota(text) {
  // lista acopera si cotele istorice: pe document poate scrie o cota veche (factura din alt an)
  const m = text.match(/(?:T\.?V\.?A\.?|cot[aă])[^0-9%]{0,6}(\d{1,2})\s*%/i) || text.match(/(\d{1,2})\s*%/);
  if (m) {
    const v = parseInt(m[1], 10);
    if ([5, 9, 11, 19, 21].includes(v)) return v;
  }
  // fara cota pe document: cota standard CURENTA din config (nu hardcodata — se schimba prin lege)
  return fiscal.FISCAL.tvaStandard;
}

/**
 * Ghiceste tipul documentului dupa cuvinte cheie si CUI-ul propriu.
 * @param {string} text
 * @param {string} ownCui - CUI-ul firmei (pentru a stabili sensul vanzare/cumparare)
 */
function guessType(text, ownCui) {
  const t = text.toLowerCase();
  const cuis = extractCUIs(text);
  const isOwnSeller = ownCui && cuis.length > 0 && cuis[0] === String(ownCui).replace(/^ro/i, '');

  if (/stat\s+de\s+plat|state\s+de\s+plat|fluturas|pontaj/.test(t)) return 'stat_plata';
  if (/amortiz/.test(t)) return 'amortizare';
  if (/(energie|electric|gaz\b|gaze\b|furnizare\s+ap|canal|salubr)/.test(t) && /factur/.test(t)) return 'factura_utilitati';
  if (/(combustibil|motorin|benzin|carburant|peco|omv|petrom|rompetrol|lukoil)/.test(t)) return 'factura_combustibil';
  if (/chitan/.test(t)) {
    if (/(am\s+primit\s+de\s+la|incasat\s+de\s+la|de\s+la\s+client)/.test(t)) return 'incasare_client';
    return 'plata_furnizor';
  }
  if (/extras\s+de\s+cont|extras\s+bancar/.test(t)) return 'plata_furnizor';
  if (/(chirie|locati|inchiriere)/.test(t) && /factur/.test(t)) return 'factura_servicii_primita';
  if (/factur/.test(t)) {
    // sens: daca emitentul (primul CUI) este firma noastra -> vanzare
    if (isOwnSeller) {
      if (/(servici|prestari|manopera|consultanta)/.test(t)) return 'factura_vanzare_servicii';
      return 'factura_vanzare_marfuri';
    }
    if (/(servici|prestari|consultanta|onorari)/.test(t)) return 'factura_servicii_primita';
    return 'factura_cumparare_marfuri';
  }
  return 'nota_contabila';
}

function extractNumber(text) {
  const pats = [
    /seria\s*([A-Z0-9]+)\s*(?:nr\.?|num[aă]r)\s*[:.]?\s*([A-Z0-9\-\/]+)/i,
    /(?:factur[aă]\s*)?(?:nr\.?|num[aă]r|no\.?|#)\s*\.?\s*(?:factur[aă]|fiscal[aă])?\s*[:.]?\s*([A-Z0-9][A-Z0-9 \-\/]{0,18})/i,
  ];
  for (const re of pats) {
    const m = text.match(re);
    if (m) {
      let val = (m[2] ? (m[1] + ' ' + m[2]) : m[1]) || '';
      // opreste la spatii multiple sau la cuvinte tipice de pe acelasi rand
      val = val.split(/\s{2,}|\s(?=data\b|din\b|client|cumparator)/i)[0].trim();
      if (/\d/.test(val)) return val.replace(/\s+/g, ' ');
    }
  }
  return '';
}

/**
 * Aplica euristicile pe textul deja extras dintr-un document.
 * Separata de parsarea PDF pentru a putea fi testata independent.
 * @returns {{text, suggestedType, fields, cuis, raw}}
 */
function extractFromText(text, ownCui) {
  const flat = String(text || '').replace(/ /g, ' ');

  const cota = guessCota(flat);
  let total = findAmountAfter(flat, ['total\\s+de\\s+plat[aă]', 'total\\s+general', 'total\\s+factur[aă]', 'total(?!\\s*(?:f[aă]r[aă]|t\\.?v\\.?a\\.?|net))']);
  let tva = findAmountAfter(flat, ['total\\s+t\\.?v\\.?a\\.?', 'valoare\\s+t\\.?v\\.?a\\.?', 't\\.?v\\.?a\\.?']);
  let baza = findAmountAfter(flat, ['total\\s+f[aă]r[aă]\\s+t\\.?v\\.?a\\.?', 'valoare\\s+f[aă]r[aă]\\s+t\\.?v\\.?a\\.?', 'baz[aă]\\s+impozabil', 'subtotal']);

  // Reconciliere robusta: total si baza sunt cele mai "ancorate" etichete
  // (eticheta "TVA" prinde uneori si textul "fara TVA"), deci le folosim prioritar.
  if (total != null && baza != null) tva = round2(total - baza);
  else if (total != null && tva != null) baza = round2(total - tva);
  else if (baza != null && tva != null) total = round2(baza + tva);
  else if (baza != null) { tva = round2((baza * cota) / 100); total = round2(baza + tva); }
  else if (total != null) { baza = round2((total * 100) / (100 + cota)); tva = round2(total - baza); }
  else if (tva != null) { baza = round2((tva * 100) / cota); total = round2(baza + tva); }

  const suggestedType = guessType(flat, ownCui);
  const cuis = extractCUIs(flat);

  // fields pre-completate (cheile acopera mai multe tipuri de document)
  const fields = {
    data: extractDate(flat),
    document: extractNumber(flat),
    partener: '',
    baza: baza != null ? round2(baza) : null,
    tva: tva != null ? round2(tva) : null,
    cota,
    suma: total != null ? round2(total) : (baza != null ? round2(baza + (tva || 0)) : null),
    brut: null,
  };

  return { text: flat, suggestedType, fields, cuis, raw: { total, baza, tva } };
}

/**
 * Extrage din buffer-ul PDF datele relevante (parsare PDF + euristici).
 * @returns {Promise<{text, suggestedType, fields, cuis, raw}>}
 */
async function extractFromPdf(buffer, ownCui) {
  const text = await extractText(buffer);
  return extractFromText(text, ownCui);
}

module.exports = { extractFromPdf, extractFromText, extractText, parseRoNumber, ownBytes };
