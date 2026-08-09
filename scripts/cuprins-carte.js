'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  CUPRINSUL CARTII DE PREZENTARE A CONTABILITATII — in trei formate, dintr-o
//  SINGURA sursa: `scripts/cuprins-carte.json`.
//
//  Cartea urmeaza ciclul contabil, adica exact ordinea pe care o impune si
//  aplicatia: fiecare parte e o faza, fiecare capitol raspunde la o intrebare
//  care apare in acel moment al lunii.
//
//  Iesiri (in public/descarcari/):
//    Cuprins-carte-contabilitate-B5.docx   editabil, B5 ISO, margini oglindite
//    Cuprins-carte-contabilitate-B5.pdf    de tipar, acelasi format
//  Plus un HTML de tipar intermediar, din care se produce PDF-ul.
//
//  ATENTIE, e o PUBLICARE: tot ce ajunge in public/ e servit imediat pe
//  internet, fara autentificare (vezi antetul lui scripts/publica-video.sh).
//
//  De ce o singura sursa: trei texte separate ar fi divergit la prima corectura,
//  iar cititorul n-ar fi avut cum sa afle care e cel bun. Aici se schimba JSON-ul
//  si se regenereaza tot.
//
//  De ce PDF-ul se face cu Chromium, nu din .docx: pe server nu exista
//  LibreOffice, iar tiparirea din HTML da control pe paginatie — `break-inside`
//  pe fiecare capitol (titlul nu se rupe de nota lui) si `break-after` pe
//  antetul de parte (nu ramane singur la baza paginii).
//
//  Rulare:  npm run cuprins-carte
//  Coduri:  0 = totul generat | 1 = eroare | 2 = NEVERIFICAT (docker lipsa, deci
//           .docx si HTML-ul s-au scris, dar PDF-ul NU) — distinctia e
//           deliberata, ca la poarta fiscala: „n-am putut produce" nu e „gata".
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');

const RADACINA = path.join(__dirname, '..');
const IESIRE = path.join(RADACINA, 'public', 'descarcari');
const NUME = 'Cuprins-carte-contabilitate-B5';
const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'cuprins-carte.json'), 'utf8'));

const MM = 56.6929; // 1 mm in twips (1 inch = 1440 twips = 25,4 mm)
const tw = (mm) => String(Math.round(mm * MM));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── 1) DOCX ────────────────────────────────────────────────────────────────
// Un .docx e un ZIP de OOXML, deci se scrie direct — fara nicio dependinta de
// conversie. `adm-zip` e deja in proiect (il foloseste exportul de firma).
function run(t, o = {}) {
  let r = '';
  if (o.b) r += '<w:b/>';
  if (o.i) r += '<w:i/>';
  if (o.color) r += `<w:color w:val="${o.color}"/>`;
  if (o.sz) r += `<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>`;
  if (o.caps) r += '<w:smallCaps/>';
  return `<w:r>${r ? `<w:rPr>${r}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
}
function P(text, style, runs) {
  const pr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pr}${runs !== undefined ? runs : run(text)}</w:p>`;
}
function stil(id, nume, sz, o = {}) {
  let ppr = `<w:spacing w:before="${o.before || 0}" w:after="${o.after || 0}" w:line="${o.line || 276}" w:lineRule="auto"/>`;
  if (o.ind || o.hang) ppr += `<w:ind w:left="${o.ind || 0}" w:hanging="${o.hang || 0}"/>`;
  if (o.keep) ppr += '<w:keepNext/>';
  let rpr = `<w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/><w:sz w:val="${sz}"/>`
    + `<w:szCs w:val="${sz}"/><w:color w:val="${o.color || '16211D'}"/>`;
  if (o.b) rpr += '<w:b/>';
  if (o.i) rpr += '<w:i/>';
  if (o.caps) rpr += '<w:smallCaps/>';
  return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${nume}"/>`
    + `<w:pPr>${ppr}</w:pPr><w:rPr>${rpr}</w:rPr></w:style>`;
}

function faDocx() {
  const b = [];
  b.push(P(D.titlu, 'Titlu'));
  b.push(P(D.subtitlu, 'Subtitlu'));
  for (const t of D.teza) b.push(P(t, 'Teza'));

  const bord = ['top', 'bottom', 'left', 'right']
    .map((x) => `<w:${x} w:val="single" w:sz="4" w:space="0" w:color="C8D0CA"/>`).join('');
  const celule = D.doua.map((c) => '<w:tc><w:tcPr><w:tcW w:w="4400" w:type="dxa"/>'
    + `<w:tcBorders>${bord}</w:tcBorders><w:shd w:val="clear" w:fill="F3F6F2"/></w:tcPr>`
    + `${P(c.cap, 'EticheCol')}${P(c.txt, 'TextCol')}</w:tc>`).join('');
  b.push('<w:tbl><w:tblPr><w:tblW w:w="8800" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>'
    + '<w:tblGrid><w:gridCol w:w="4400"/><w:gridCol w:w="4400"/></w:tblGrid>'
    + `<w:tr>${celule}</w:tr></w:tbl>`);
  b.push(P('', 'Gol'));

  for (const p of D.parti) {
    const et = p.nr === '—' ? 'Anexe' : `PARTEA ${p.nr}`;
    b.push(P('', null, run(et, { caps: true, color: '2C5B44', sz: '17' })));
    b.push(P(p.titlu, 'Parte'));
    b.push(P(p.faza, 'Faza'));
    if (p.rezumat) b.push(P(p.rezumat, 'Rezumat'));
    for (const c of p.capitole) {
      const runs = run(`${c.nr} `, { color: '7C8A83' })
        + run(c.titlu, { b: true, color: c.semn ? '9E2A20' : undefined });
      b.push(P('', 'Capitol', runs));
      b.push(P(c.nota, 'Nota'));
    }
  }
  b.push(P('', 'Gol'));
  for (const s of D.subsol) b.push(P('', 'Subsol', run(`${s.cap} — `, { b: true }) + run(s.txt)));

  // B5 ISO 176 x 250 mm, margini OGLINDITE (cotor mai lat) — carte, nu raport.
  const sect = `<w:sectPr><w:pgSz w:w="${tw(176)}" w:h="${tw(250)}"/>`
    + `<w:pgMar w:top="${tw(20)}" w:right="${tw(18)}" w:bottom="${tw(20)}" w:left="${tw(22)}" `
    + `w:header="${tw(12)}" w:footer="${tw(12)}" w:gutter="0"/>`
    + '<w:footerReference w:type="default" r:id="rId3"/><w:mirrorMargins/></w:sectPr>';

  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<w:body>${b.join('')}${sect}</w:body></w:document>`;

  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/>'
    + '<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="ro-RO"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="276" w:lineRule="auto"/></w:pPr>'
    + '</w:pPrDefault></w:docDefaults>'
    + stil('Normal', 'Normal', '21')
    + stil('Titlu', 'Titlu carte', '52', { b: 1, after: 120, line: 240 })
    + stil('Subtitlu', 'Subtitlu', '21', { i: 1, color: '55645C', after: 360 })
    + stil('Teza', 'Teza', '21', { after: 140 })
    + stil('EticheCol', 'Eticheta coloana', '16', { b: 1, caps: 1, color: '55645C', after: 60 })
    + stil('TextCol', 'Text coloana', '18', { color: '55645C' })
    + stil('Parte', 'Parte', '30', { b: 1, after: 40, line: 240, keep: 1 })
    + stil('Faza', 'Faza', '16', { caps: 1, color: '7C8A83', after: 100, keep: 1 })
    + stil('Rezumat', 'Rezumat parte', '19', { i: 1, color: '55645C', after: 160, keep: 1 })
    + stil('Capitol', 'Capitol', '21', { before: 90, after: 20, ind: 567, hang: 567, keep: 1 })
    + stil('Nota', 'Nota capitol', '18', { color: '55645C', ind: 567, after: 40 })
    + stil('Subsol', 'Subsol', '18', { color: '55645C', after: 120 })
    + stil('Gol', 'Gol', '16', { after: 240 })
    + '</w:styles>';

  const footer = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120"/></w:pPr>'
    + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
    + '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>';

  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '</Types>', 'utf8'));
  z.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '</Relationships>', 'utf8'));
  z.addFile('docProps/core.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:title>${esc(D.titlu)}</dc:title>`
    + '<dc:subject>Cuprins — carte de prezentare a contabilitatii</dc:subject>'
    + '<dc:language>ro-RO</dc:language></cp:coreProperties>', 'utf8'));
  z.addFile('word/_rels/document.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
    + '</Relationships>', 'utf8'));
  z.addFile('word/document.xml', Buffer.from(doc, 'utf8'));
  z.addFile('word/styles.xml', Buffer.from(styles, 'utf8'));
  z.addFile('word/footer1.xml', Buffer.from(footer, 'utf8'));
  const cale = path.join(IESIRE, `${NUME}.docx`);
  z.writeZip(cale);
  return cale;
}

// ── 2) HTML de tipar ───────────────────────────────────────────────────────
function faHtml() {
  const parti = D.parti.map((p) => {
    const et = p.nr === '—' ? 'Anexe' : `Partea ${esc(p.nr)}`;
    const randuri = p.capitole.map((c) => `<div class="rand${c.semn ? ' semn' : ''}">`
      + `<span class="nr">${esc(c.nr)}</span><div class="txt"><b>${esc(c.titlu)}</b>`
      + `<span class="nota">${esc(c.nota)}</span></div></div>`).join('\n');
    return `<section class="parte"><p class="parte-et">${et}</p><h2>${esc(p.titlu)}</h2>`
      + `<p class="faza">${esc(p.faza)}</p>`
      + (p.rezumat ? `<p class="rezumat">${esc(p.rezumat)}</p>` : '')
      + `<div class="randuri">${randuri}</div></section>`;
  }).join('\n');

  return `<!doctype html><html lang="ro"><head><meta charset="utf-8">
<title>${esc(D.titlu)}</title>
<style>
  @page { size: 176mm 250mm; margin: 20mm 18mm 18mm 22mm; }
  :root { --paper:#FFFFFF; --bar:#EFF4ED; --card:#F5F8F3; --ink:#16211D; --ink-2:#55645C;
          --ink-3:#7C8A83; --rule:#C8D6C9; --rule-2:#A9BCAB; --rosu:#9E2A20; --verde:#2C5B44; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
    font-family:"Cambria","Palatino Linotype",Palatino,Charter,Georgia,serif;
    font-size:10.5pt; line-height:1.42; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  h1 { font-size:26pt; line-height:1.06; margin:0 0 6pt; font-weight:600; letter-spacing:-0.01em; }
  .subtitlu { font-size:11pt; color:var(--ink-2); font-style:italic; margin:0 0 16pt; }
  .antet { border-bottom:1.5pt solid var(--ink); padding-bottom:10pt; margin-bottom:14pt; }
  .eticheta { font-size:7.5pt; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3);
              margin:0 0 10pt; font-family:Calibri,Arial,sans-serif; }
  .teza { border-left:2pt solid var(--verde); padding-left:9pt; margin:0 0 14pt; }
  .teza p { margin:0 0 5pt; }
  .doua { display:grid; grid-template-columns:1fr 1fr; border:.6pt solid var(--rule);
          background:var(--card); margin:0 0 18pt; break-inside:avoid; }
  .doua > div { padding:7pt 9pt; }
  .doua > div + div { border-left:.6pt solid var(--rule); }
  .doua h3 { font-size:7.5pt; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3);
             margin:0 0 3pt; font-family:Calibri,Arial,sans-serif; font-weight:700; }
  .doua p { margin:0; font-size:9pt; color:var(--ink-2); }
  .parte { margin:0 0 15pt; }
  .parte-et { font-size:7.5pt; letter-spacing:.13em; text-transform:uppercase; color:var(--verde);
              margin:0 0 2pt; font-family:Calibri,Arial,sans-serif; font-weight:700; break-after:avoid; }
  .parte h2 { font-size:15pt; margin:0 0 1pt; font-weight:600; break-after:avoid;
              border-bottom:.8pt solid var(--rule-2); padding-bottom:3pt; }
  .faza { font-size:7.5pt; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3);
          margin:3pt 0 0; font-family:Calibri,Arial,sans-serif; break-after:avoid; }
  .rezumat { font-size:9pt; font-style:italic; color:var(--ink-2); margin:4pt 0 7pt; break-after:avoid; }
  .randuri { border-top:.6pt solid var(--rule); }
  .rand { display:grid; grid-template-columns:20pt 1fr; gap:0 7pt; padding:3.5pt 5pt;
          border-bottom:.6pt solid var(--rule); break-inside:avoid; }
  .rand:nth-child(even) { background:var(--bar); }
  .nr { font-family:Consolas,"DejaVu Sans Mono",monospace; font-size:8pt; color:var(--ink-3);
        text-align:right; font-variant-numeric:tabular-nums; }
  .txt b { font-weight:600; }
  .nota { display:block; font-size:8.5pt; color:var(--ink-2); margin-top:.5pt; }
  .rand.semn .nr, .rand.semn .txt b { color:var(--rosu); }
  .subsol { margin-top:16pt; padding-top:8pt; border-top:1.5pt solid var(--ink);
            font-size:8.5pt; color:var(--ink-2); break-inside:avoid; }
  .subsol p { margin:0 0 4pt; }
  .subsol b { color:var(--ink); }
</style></head><body>
<header class="antet">
  <p class="eticheta">Cuprins · carte de prezentare</p>
  <h1>${esc(D.titlu)}</h1>
  <p class="subtitlu">${esc(D.subtitlu)}</p>
</header>
<div class="teza">${D.teza.map((t) => `<p>${esc(t)}</p>`).join('')}</div>
<div class="doua">${D.doua.map((c) => `<div><h3>${esc(c.cap)}</h3><p>${esc(c.txt)}</p></div>`).join('')}</div>
${parti}
<footer class="subsol">${D.subsol.map((s) => `<p><b>${esc(s.cap)}</b> — ${esc(s.txt)}</p>`).join('')}</footer>
</body></html>`;
}

// ── 3) PDF (Chromium, in container) ────────────────────────────────────────
// Pe server nu exista browser, deci se foloseste imaginea Playwright — aceeasi
// pe care o folosesc filmarea si capturile de marketing.
const IMAGINE = 'mcr.microsoft.com/playwright:v1.58.2-noble';
function faPdf(htmlCale) {
  try { execFileSync('docker', ['--version'], { stdio: 'ignore' }); }
  catch (_) { return null; } // docker lipsa -> NEVERIFICAT, semnalat de apelant
  const lucru = fs.mkdtempSync(path.join(os.tmpdir(), 'cuprins-'));
  fs.copyFileSync(htmlCale, path.join(lucru, 'tipar.html'));
  fs.writeFileSync(path.join(lucru, 'fa-pdf.mjs'), `import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await (await b.newContext()).newPage();
await pg.goto('file:///w/tipar.html', { waitUntil: 'networkidle' });
await pg.pdf({ path: '/w/iesire.pdf', width: '176mm', height: '250mm',
  margin: { top: '20mm', right: '18mm', bottom: '18mm', left: '22mm' },
  printBackground: true, displayHeaderFooter: true, headerTemplate: '<div></div>',
  footerTemplate: '<div style="width:100%;text-align:center;font-family:Cambria,Georgia,serif;font-size:8pt;color:#7C8A83;"><span class="pageNumber"></span></div>' });
await b.close();
`);
  execFileSync('docker', ['run', '--rm', '-v', `${lucru}:/w`, '-w', '/w', IMAGINE,
    'sh', '-c', 'npm i --no-save playwright@1.58.2 >/dev/null 2>&1 && node fa-pdf.mjs'],
  { stdio: 'inherit' });
  const cale = path.join(IESIRE, `${NUME}.pdf`);
  fs.copyFileSync(path.join(lucru, 'iesire.pdf'), cale);
  fs.rmSync(lucru, { recursive: true, force: true });
  return cale;
}

// ── Rulare ─────────────────────────────────────────────────────────────────
fs.mkdirSync(IESIRE, { recursive: true });
const nrCap = D.parti.reduce((s, p) => s + p.capitole.length, 0);
console.log(`── Cuprins: ${D.parti.length} sectiuni, ${nrCap} intrari`);

const docx = faDocx();
fs.chmodSync(docx, 0o644);
console.log(`   .docx  ${(fs.statSync(docx).size / 1024).toFixed(1)} KB  ${path.relative(RADACINA, docx)}`);

const htmlCale = path.join(os.tmpdir(), `${NUME}.html`);
fs.writeFileSync(htmlCale, faHtml(), 'utf8');

const pdf = faPdf(htmlCale);
if (!pdf) {
  console.error('NEVERIFICAT: docker lipseste, PDF-ul NU s-a produs (.docx si HTML-ul sunt scrise).');
  process.exit(2);
}
fs.chmodSync(pdf, 0o644);
console.log(`   .pdf   ${(fs.statSync(pdf).size / 1024).toFixed(1)} KB  ${path.relative(RADACINA, pdf)}`);
console.log('   B5 ISO 176 x 250 mm, margini oglindite, numerotare in subsol');
console.log('   https://contabo.space/descarcari/' + NUME + '.pdf');
