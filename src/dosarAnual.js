'use strict';

// DOSARUL CONTABIL ANUAL — arhiva imutabila a exercitiului inchis. Asambleaza, per firma/an,
// documentele obligatorii (registrele, balanta, situatiile financiare) + declaratiile depuse
// (XML), intr-un singur ZIP cu un MANIFEST care poarta amprenta SHA-256 a fiecarui fisier si o
// amprenta combinata a intregului dosar (tamper-evident: orice modificare ulterioara schimba
// hash-ul). Acopera obligatia de pastrare si da contabilului „dosarul anului" dintr-un click.
//
// Nu introduce date noi: reasambleaza artefactele din functiile existente (pdf/*, xml, accounting,
// reporting, statements, saft) peste vederea scoped, pe date deja INCHISE (an blocat) => regenerare
// deterministica. Fiecare artefact se genereaza independent; un esec se noteaza in manifest, nu
// doboara dosarul.

const crypto = require('crypto');
const ptOpts = require('./profitTaxOptions'); // sursa unica a optiunilor de impozit pe profit
const { Writable } = require('stream');

const pdf = require('./pdf');
const xml = require('./xml');
const acc = require('./accounting');
const rep = require('./reporting');
const stmt = require('./statements');
const saft = require('./saft');
const fiscalProfile = require('./fiscalProfile');

/** Ruleaza un generator PDF (care scrie intr-un `res`) si intoarce continutul ca Buffer.
 *  Generatoarele cheama res.setHeader(...) + doc.pipe(res) + doc.end() — ii dam un Writable
 *  care colecteaza si care are un setHeader inofensiv. */
function pdfToBuffer(pdfFn) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
    sink.setHeader = () => {};        // finish() din pdf/helpers apeleaza res.setHeader
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    try { pdfFn(sink); } catch (e) { reject(e); }
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Lunile/perioadele de TVA ale anului dupa regim: lunar -> 12 luni; trimestrial -> 4 trimestre. */
function vatPeriods(company, year) {
  if (company && company.perioadaTva === 'T') return ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => year + '-' + q);
  return Array.from({ length: 12 }, (_, i) => year + '-' + String(i + 1).padStart(2, '0'));
}

/**
 * Construieste dosarul anual pentru vederea `v` (firma scoped) si anul `year`.
 * @returns { name, buffer, manifest } — ZIP-ul si manifestul (pentru audit/loguri).
 */
async function build(v, year, opts) {
  opts = opts || {};
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const company = v.company || {};
  const profile = fiscalProfile.build(company, { angajati: v.angajati });
  const who = opts.who || null;
  const fisiere = []; // { cale, sha256, octeti }
  const erori = [];   // { cale, motiv }

  // Adauga un artefact in zip + manifest (buffer sau string). Erorile se noteaza, nu opresc dosarul.
  const add = (cale, producer) => Promise.resolve()
    .then(producer)
    .then((data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      zip.addFile(cale, buf);
      fisiere.push({ cale, sha256: sha256(buf), octeti: buf.length });
    })
    .catch((e) => { erori.push({ cale, motiv: e.message || String(e) }); });

  const dec = year + '-12';
  const anPrec = String(Number(year) - 1) + '-12';

  // 1) Registrele obligatorii (an intreg) + balanta la 31.12
  await add('registre/registru-jurnal.pdf', () => pdfToBuffer((res) => pdf.journalPdf(res, company, acc.journal(v, year))));
  await add('registre/cartea-mare.pdf', () => pdfToBuffer((res) => pdf.ledgerPdf(res, company, acc.ledger(v, year), year)));
  await add('registre/balanta-' + dec + '.pdf', () => pdfToBuffer((res) => pdf.trialBalancePdf(res, company, acc.trialBalance(v, dec))));
  await add('registre/registru-inventar.pdf', () => pdfToBuffer((res) => pdf.registruInventarPdf(res, company, rep.registruInventar(v, dec, year))));
  await add('registre/registru-fiscal.pdf', () => pdfToBuffer((res) => pdf.registruFiscalPdf(res, company, rep.registruFiscal(v, year))));

  // 2) Situatiile financiare anuale (bilant F10 + cont de profit si pierdere F20, cu anul precedent)
  await add('situatii/bilant.pdf', () => pdfToBuffer((res) => pdf.balanceSheetPdf(res, company, stmt.balanceSheetF10(v, dec), stmt.balanceSheetF10(v, anPrec), stmt.balanceSheet(v, dec))));
  await add('situatii/cont-profit-pierdere.pdf', () => pdfToBuffer((res) => pdf.plPdf(res, company, stmt.profitLossF20(v, year), stmt.profitLossF20(v, Number(year) - 1), stmt.profitLoss(v, year))));

  // 3) Declaratiile depuse (XML), dupa profilul fiscal al firmei
  if (profile.profit) {
    await add('declaratii/d101-' + year + '.xml', () => xml.d101Xml(company, rep.d101(v, year, ptOpts.pentruDeclaratie(v, year)), who));
  }
  if (profile.tvaPlatitor) {
    for (const p of vatPeriods(company, year)) {
      const vj = acc.vatJournals(v, p);
      // include doar perioadele cu activitate de TVA (baza sau taxa) — evita 12 deconturi goale
      if (vj.totals.bazaV || vj.totals.bazaC || vj.totals.colectata || vj.totals.deductibila) {
        await add('declaratii/d300-' + p + '.xml', () => xml.d300Xml(company, p, rep.d300(v, p), who));
      }
    }
  }
  // SAF-T anual (D406, varianta A) — best-effort (poate fi mare/lent la firme mari)
  await add('declaratii/saft-d406-' + year + '.xml', () => saft.saftXmlAsync(v, year));

  // 4) Manifest cu amprentele + amprenta combinata a dosarului (tamper-evident)
  fisiere.sort((a, b) => a.cale.localeCompare(b.cale));
  const amprentaCombinata = sha256(Buffer.from(fisiere.map((f) => f.cale + ':' + f.sha256).join('\n'), 'utf8'));
  const manifest = {
    dosar: 'Dosar contabil anual',
    firma: { nume: company.nume || '', cui: company.cui || '', regCom: company.regCom || '' },
    an: String(year),
    generatLa: new Date().toISOString(),
    generatDe: opts.username || null,
    algoritm: 'sha256',
    fisiere,
    erori,
    hashDosar: amprentaCombinata,
    nota: 'Dosar imutabil: recalculeaza SHA-256 pe fiecare fisier, sorteaza „cale:sha256", concateneaza cu \\n si verifica hashDosar. Orice modificare a unui fisier schimba hashDosar.',
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  zip.addFile('manifest.json', manifestBuf);
  zip.addFile('README.txt', Buffer.from(
    'DOSAR CONTABIL ANUAL — ' + (company.nume || '') + ' — exercitiul ' + year + '\n\n'
    + 'Contine registrele obligatorii, balanta de verificare, situatiile financiare anuale si\n'
    + 'declaratiile fiscale depuse (XML), pentru pastrare si control.\n\n'
    + 'INTEGRITATE (manifest.json): fiecare fisier are amprenta SHA-256; „hashDosar" e amprenta\n'
    + 'combinata a intregului dosar. Verificare: recalculezi SHA-256 pe fiecare fisier, formezi\n'
    + 'liniile „cale:sha256", le sortezi, le unesti cu newline si aplici SHA-256 -> trebuie sa dea\n'
    + 'hashDosar. Orice modificare ulterioara a unui fisier schimba amprenta.\n\n'
    + 'Generat de Contabo la ' + manifest.generatLa + '.\n', 'utf8'));

  const safeNume = (company.nume || 'firma').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'firma';
  return { name: 'dosar-anual-' + safeNume + '-' + year + '.zip', buffer: zip.toBuffer(), manifest };
}

module.exports = { build, pdfToBuffer, vatPeriods };
