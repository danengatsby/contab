'use strict';

// Regresie pentru consolidarea extragerii de text pe pdf2json (pdf-parse scos).
// Extragerea de PDF e calea de REZERVA (fara AI) din routes/documents.js: acolo
// `await extractFromPdf(buf)` NU e prins de try/catch, deci proprietatea critica e
// ca extractText/extractFromPdf sa nu ARUNCE niciodata — un PDF ilizibil cade elegant
// pe completare manuala (text gol), nu pe 500. Fixtura sintetica de PDF valid e evitata
// intentionat: xref-ul minimal declanseaza calea de recuperare instabila din pdf.js
// (nereprezentativa; PDF-urile reale parseaza fiabil) — calitatea extragerii e dovedita
// offline, aici blocam contractul de siguranta si absenta dependentei scoase.

const ex = require('../src/extractor');

let pass = 0; let fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name); } }
function eq(name, got, want) { ok(name + ' (=' + JSON.stringify(want) + ', got ' + JSON.stringify(got) + ')', got === want); }

// pdf2json arunca diagnosticul intern al pdf.js pe stdout/stderr cand parseaza gunoi;
// aici parsam gunoi INTENTIONAT (contractul de esec), deci reducem la tacere in jurul apelului.
async function silent(fn) {
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true; process.stderr.write = () => true;
  try { return await fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
}

(async () => {
  // 1. pdf-parse a fost scos deliberat — reintroducerea lui trebuie observata
  let pdfParseAbsent = false;
  try { require('pdf-parse/lib/pdf-parse.js'); } catch (_) { pdfParseAbsent = true; }
  ok('pdf-parse nu mai e dependenta (scos in favoarea pdf2json)', pdfParseAbsent);

  // 2. extractText nu arunca pe intrari ilizibile — rezolva '' (contractul rutei)
  eq('extractText: buffer non-PDF -> ""', await silent(() => ex.extractText(Buffer.from('nu este un pdf deloc'))), '');
  eq('extractText: buffer gol -> ""', await silent(() => ex.extractText(Buffer.alloc(0))), '');
  eq('extractText: antet %PDF fara structura -> ""', await silent(() => ex.extractText(Buffer.from('%PDF-1.4 dar trunchiat'))), '');

  // 3. extractFromPdf integreaza extractText + euristicile fara sa arunce pe intrare invalida
  const r = await silent(() => ex.extractFromPdf(Buffer.from('gunoi'), '12345678'));
  ok('extractFromPdf: intrare invalida -> obiect, nu exceptie', r && typeof r === 'object');
  eq('extractFromPdf: text gol', r.text, '');
  ok('extractFromPdf: campuri prezente (goale)', r.fields && r.fields.baza == null && r.fields.data === '');
  ok('extractFromPdf: fara CUIs pe gunoi', Array.isArray(r.cuis) && r.cuis.length === 0);

  // 4. euristicile pure raman intacte peste extractText (paritatea de campuri dovedita offline)
  const fct = 'FACTURA nr. EN 9981 din 20.04.2026\nFurnizor: ELECTRICA SA CUI RO13267221\n' +
    'Client: EXEMPLU SRL CIF RO12345678\nBaza impozabila 300,00\nTVA 9% 27,00\nTotal de plata 327,00 lei';
  const h = ex.extractFromText(fct, '12345678');
  eq('extractFromText: data', h.fields.data, '2026-04-20');
  eq('extractFromText: cota', h.fields.cota, 9);
  eq('extractFromText: suma', h.fields.suma, 327);
  ok('extractFromText: CUIs ambele', h.cuis.includes('13267221') && h.cuis.includes('12345678'));

  // ── Buffer din POOL: defectul TACUT al extragerii de text ──────────────────
  // `fs.readFileSync` aloca din pool pentru fisiere sub 4 KB (Buffer.poolSize >>> 1), deci
  // intoarce o VEDERE intr-un ArrayBuffer partajat (byteOffset != 0). pdf2json/pdf.js citeste
  // ArrayBuffer-ul SUBIACENT intreg, ignorand byteOffset/length -> parsa octeti straini si
  // esua cu „Invalid XRef stream header". Cum extractText inghite eroarea prin proiectare,
  // orice PDF sub 4 KB nu dadea text si NIMIC nu semnala asta. Reprodus si masurat pe PDF-uri
  // reale: 3.344 si 3.403 octeti -> zero text; 4.742 octeti (byteOffset 0) -> corect.
  const { ownBytes } = require('../src/extractor');
  {
    const partajat = new ArrayBuffer(64);
    new Uint8Array(partajat).fill(0xAA);              // „octetii altcuiva" din pool
    const vedere = new Uint8Array(partajat, 8, 16);   // exact forma unui Buffer din pool
    for (let i = 0; i < 16; i += 1) vedere[i] = i + 1; // datele NOASTRE, distincte de 0xAA
    ok('vederea din pool chiar are byteOffset != 0 (altfel testul n-ar dovedi nimic)', vedere.byteOffset === 8);
    const n = ownBytes(vedere);
    eq('ownBytes muta octetii intr-un ArrayBuffer propriu', n.byteOffset, 0);
    eq('...de exact lungimea datelor, nu a pool-ului', n.buffer.byteLength, 16);
    ok('...cu acelasi continut', [...n].join(',') === [...vedere].join(','));
    ok('...si fara octetii straini din pool', ![...new Uint8Array(n.buffer)].includes(0xAA));
  }
  {
    // deja standalone -> se intoarce ACELASI obiect (fara copie inutila peste prag)
    const propriu = new Uint8Array(32);
    ok('un buffer deja propriu nu se copiaza', ownBytes(propriu) === propriu);
  }
  ok('buffer lipsa nu arunca', ownBytes(null) === null && ownBytes(undefined) === undefined);

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari extractor trecute, ' + fail + ' esuate.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
