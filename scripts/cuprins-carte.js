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
// Capitolele scrise pe larg vin din fisiere proprii, ca sa nu umfle cuprinsul. Cartea se
// construieste in ordinea din `CAPITOLE`: cuprinsul, apoi textul, in ordinea din carte.
const CAPITOLE = ['cuprins-carte-cap1.json', 'cuprins-carte-cap2.json', 'cuprins-carte-cap3.json', 'cuprins-carte-cap4.json', 'cuprins-carte-cap5.json', 'cuprins-carte-cap6.json', 'cuprins-carte-cap7.json']
  .map((f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')));

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

  // ── Capitolele scrise pe larg, dupa cuprins, fiecare pe pagina noua ──
  for (const c of CAPITOLE) {
    b.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    b.push(P(c.parte, 'CapParte'));
    b.push(P(`Capitolul ${c.nr}`, 'CapNr'));
    b.push(P(c.titlu, 'CapTitlu'));
    for (const bl of c.blocuri) {
      if (bl.tip === 'p') b.push(P(bl.text, 'Corp'));
      else if (bl.tip === 'h') b.push(P(bl.text, 'H2'));
      else if (bl.tip === 'cheie') b.push(P(bl.text, 'Cheie'));
      else if (bl.tip === 'contabil') {
        b.push(P(bl.titlu, 'ContabilT'));
        b.push(P(bl.text, 'Contabil'));
      } else if (bl.tip === 'recap') {
        b.push(P(bl.titlu, 'RecapT'));
        for (const pt of bl.puncte) b.push(P('', 'Recap', run('•\u00a0\u00a0') + run(pt)));
      } else if (bl.tip === 'tabel') {
        if (bl.titlu) b.push(P(bl.titlu, 'TabTitlu'));
        const lat = Math.floor(8800 / bl.cap.length);
        const cel = (t, stil2, fill, dr) => `<w:tc><w:tcPr><w:tcW w:w="${lat}" w:type="dxa"/>`
          + `<w:tcBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="C8D0CA"/>`
          + `<w:bottom w:val="single" w:sz="4" w:space="0" w:color="C8D0CA"/></w:tcBorders>`
          + (fill ? `<w:shd w:val="clear" w:fill="${fill}"/>` : '')
          + `</w:tcPr>${dr ? `<w:p><w:pPr><w:pStyle w:val="${stil2}"/><w:jc w:val="right"/></w:pPr>${run(t)}</w:p>` : P(t, stil2)}</w:tc>`;
        let tbl = '<w:tbl><w:tblPr><w:tblW w:w="8800" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>'
          + '<w:tblGrid>' + bl.cap.map(() => `<w:gridCol w:w="${lat}"/>`).join('') + '</w:tblGrid>';
        const eNum = (i) => (bl.numerice || []).includes(i + 1);
        tbl += '<w:tr>' + bl.cap.map((t, i) => cel(t, 'TabCap', 'EDF2EB', eNum(i))).join('') + '</w:tr>';
        bl.randuri.forEach((r, i) => {
          const fill = i % 2 ? 'F7FAF6' : null;
          const st = (bl.total && i === bl.randuri.length - 1) ? 'TabCap' : 'TabCel';
          tbl += '<w:tr>' + r.map((t, j) => cel(t, st, fill, eNum(j))).join('') + '</w:tr>';
        });
        tbl += '</w:tbl>';
        b.push(tbl);
        if (bl.nota) b.push(P(bl.nota, 'TabNota'));
      }
    }
  }

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
    + stil('CapParte', 'Capitol - parte', '17', { caps: 1, color: '2C5B44', after: 40, keep: 1 })
    + stil('CapNr', 'Capitol - numar', '19', { color: '7C8A83', after: 30, keep: 1 })
    + stil('CapTitlu', 'Capitol - titlu', '40', { b: 1, after: 200, line: 240, keep: 1 })
    + stil('H2', 'Titlu sectiune', '25', { b: 1, before: 280, after: 90, keep: 1 })
    + stil('Corp', 'Corp text', '21', { after: 130, line: 300 })
    + stil('Cheie', 'Idee-cheie', '20', { b: 1, i: 1, color: '2C5B44', before: 60, after: 180, ind: 340 })
    + stil('ContabilT', 'Pentru contabil - titlu', '17', { b: 1, caps: 1, color: '55645C', after: 50 })
    + stil('Contabil', 'Pentru contabil', '19', { color: '55645C', after: 60, line: 288 })
    + stil('TabTitlu', 'Tabel - titlu', '18', { b: 1, caps: 1, color: '55645C', before: 160, after: 60, keep: 1 })
    + stil('TabCap', 'Tabel - antet', '18', { b: 1, after: 0 })
    + stil('TabCel', 'Tabel - celula', '18', { after: 0 })
    + stil('TabNota', 'Tabel - nota', '17', { i: 1, color: '55645C', before: 60, after: 180 })
    + stil('RecapT', 'Recapitulare - titlu', '18', { b: 1, caps: 1, color: '2C5B44', after: 70 })
    + stil('Recap', 'Recapitulare', '19', { color: '16211D', after: 70, ind: 340, hang: 170 })
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

  .capitol { break-before:page; padding-top:0; }
  .cap-parte { font-size:7.5pt; letter-spacing:.13em; text-transform:uppercase; color:var(--verde);
    margin:0 0 2pt; font-family:Calibri,Arial,sans-serif; font-weight:700; break-after:avoid; }
  .cap-nr { font-family:Consolas,monospace; font-size:8pt; color:var(--ink-3); margin:0 0 3pt;
    break-after:avoid; }
  .cap-titlu { font-size:20pt; line-height:1.12; margin:0 0 12pt; font-weight:600; break-after:avoid; }
  .capitol p { margin:0 0 6pt; text-align:justify; hyphens:auto; }
  .capitol h3 { font-size:12pt; font-weight:600; margin:14pt 0 5pt; break-after:avoid; }
  .cheie { border-left:2pt solid var(--verde); padding-left:7pt; font-style:italic;
    color:var(--verde); font-weight:600; margin:8pt 0 10pt !important; text-align:left !important; }
  .contabil { border:.6pt solid var(--rule); background:var(--card); padding:7pt 9pt; margin:11pt 0;
    break-inside:avoid; }
  .contabil h4 { font-size:7.5pt; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3);
    margin:0 0 3pt; font-family:Calibri,Arial,sans-serif; font-weight:700; }
  .contabil p { margin:0 !important; font-size:9pt; color:var(--ink-2); }
  .recap { border-top:1.2pt solid var(--verde); padding-top:6pt; margin:14pt 0 0; break-inside:avoid; }
  .recap h4 { font-size:7.5pt; letter-spacing:.12em; text-transform:uppercase; color:var(--verde);
    margin:0 0 4pt; font-family:Calibri,Arial,sans-serif; font-weight:700; }
  .recap ul { margin:0; padding-left:11pt; }
  .recap li { margin:0 0 3pt; }
  .tab { margin:9pt 0 10pt; break-inside:avoid; }
  .tab figcaption { font-size:7.5pt; letter-spacing:.12em; text-transform:uppercase;
    color:var(--ink-3); margin:0 0 3pt; font-family:Calibri,Arial,sans-serif; font-weight:700; }
  .tab table { border-collapse:collapse; width:100%; font-size:9pt; }
  .tab th { text-align:left; background:var(--bar); font-weight:600; }
  .tab th, .tab td { border-top:.6pt solid var(--rule); border-bottom:.6pt solid var(--rule);
    padding:2.5pt 4pt; }
  .tab th.num, .tab td.num { text-align:right; }
  .tab td.num { font-variant-numeric:tabular-nums; }
  .tab tbody tr.total td { font-weight:600; }
  .tab-nota { font-size:8.5pt; color:var(--ink-2); margin:4pt 0 0 !important; font-style:italic;
    text-align:left !important; }
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
${CAPITOLE.map(blocuriHtml).join('\n')}
</body></html>`;
}


// Blocurile unui capitol -> HTML. Acelasi marcaj pentru ecran si pentru tipar; difera doar CSS-ul,
// deci un bloc nou se adauga o singura data, nu in doua locuri care ar putea drifta.
// Coloanele numerice se DECLARA in date (`numerice`, 1-based), nu se ghicesc din pozitie.
// Regula veche `nth-child(even)` mergea la tabelele cu 2 si 4 coloane si se inversa la cel cu 5:
// textul iesea aliniat la dreapta si cifrele la stanga.
const num = (bl, i) => ((bl.numerice || []).includes(i + 1) ? ' class="num"' : '');

function blocuriHtml(c) {
  const out = [`<section class="capitol"><p class="cap-parte">${esc(c.parte)}</p>`
    + `<p class="cap-nr">Capitolul ${esc(c.nr)}</p><h2 class="cap-titlu">${esc(c.titlu)}</h2>`];
  for (const bl of c.blocuri) {
    if (bl.tip === 'p') out.push(`<p>${esc(bl.text)}</p>`);
    else if (bl.tip === 'h') out.push(`<h3>${esc(bl.text)}</h3>`);
    else if (bl.tip === 'cheie') out.push(`<p class="cheie">${esc(bl.text)}</p>`);
    else if (bl.tip === 'contabil') {
      out.push(`<aside class="contabil"><h4>${esc(bl.titlu)}</h4><p>${esc(bl.text)}</p></aside>`);
    } else if (bl.tip === 'recap') {
      out.push(`<aside class="recap"><h4>${esc(bl.titlu)}</h4><ul>`
        + bl.puncte.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul></aside>');
    } else if (bl.tip === 'tabel') {
      out.push('<figure class="tab">'
        + (bl.titlu ? `<figcaption>${esc(bl.titlu)}</figcaption>` : '')
        + '<table><thead><tr>' + bl.cap.map((t, i) => `<th${num(bl, i)}>${esc(t)}</th>`).join('') + '</tr></thead><tbody>'
        + bl.randuri.map((r, k) => `<tr${bl.total && k === bl.randuri.length - 1 ? ' class="total"' : ''}>`
            + r.map((t, i) => `<td${num(bl, i)}>${esc(t)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>'
        + (bl.nota ? `<p class="tab-nota">${esc(bl.nota)}</p>` : '') + '</figure>');
    }
  }
  out.push('</section>');
  return out.join('\n');
}

// ── 2b) HTML de CITIT ──────────────────────────────────────────────────────
// Alt fisier decat cel de tipar, si nu din lene: cel de tipar e fixat pe B5, alb, cu
// intreruperi de pagina. Acesta e pentru ecran — se adapteaza la latime, urmeaza tema
// cititorului (deschisa/intunecata) si nu are nimic legat de hartie. Se genereaza din
// ACELASI JSON, deci nu poate spune altceva decat celelalte trei.
function faHtmlEcran() {
  const parti = D.parti.map((p) => {
    const et = p.nr === '—' ? 'Anexe' : `Partea ${esc(p.nr)}`;
    const randuri = p.capitole.map((c) => `<div class="rand${c.semn ? ' semn' : ''}">`
      + `<span class="nr">${esc(c.nr)}</span><p class="titlu"><b>${esc(c.titlu)}</b>`
      + `<span class="nota">${esc(c.nota)}</span></p></div>`).join('\n');
    return `<section class="parte"><div class="parte-cap"><span class="parte-nr">${et}</span>`
      + `<h2>${esc(p.titlu)}</h2><span class="faza">${esc(p.faza)}</span></div>`
      + (p.rezumat ? `<p class="rezumat">${esc(p.rezumat)}</p>` : '')
      + `<div class="randuri">${randuri}</div></section>`;
  }).join('\n');

  return `<!doctype html><html lang="ro"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(D.titlu)}</title>
<style>
  :root { --paper:#FCFDFB; --bar:#EBF1E8; --card:#F5F8F3; --ink:#16211D; --ink-2:#55645C;
          --ink-3:#7C8A83; --rule:#CBD8CC; --rule-2:#A9BCAB; --rosu:#9E2A20; --verde:#2C5B44; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --paper:#0F1512; --bar:#161E19; --card:#18211C; --ink:#DFE7DF; --ink-2:#9BAAA1;
    --ink-3:#74837B; --rule:#2A362E; --rule-2:#3D4C42; --rosu:#D97A6C; --verde:#8FC0A4; } }
  :root[data-theme="dark"] {
    --paper:#0F1512; --bar:#161E19; --card:#18211C; --ink:#DFE7DF; --ink-2:#9BAAA1;
    --ink-3:#74837B; --rule:#2A362E; --rule-2:#3D4C42; --rosu:#D97A6C; --verde:#8FC0A4; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font-size:17px; line-height:1.55;
    font-family:"Iowan Old Style","Palatino Linotype",Palatino,Charter,Georgia,serif;
    -webkit-font-smoothing:antialiased; }
  .foaie { max-width:60rem; margin:0 auto; padding:4rem 1.5rem 6rem; }
  .antet { border-bottom:2px solid var(--ink); padding-bottom:2rem; margin-bottom:.5rem; }
  .eticheta { font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; font-size:.72rem;
    letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3); margin:0 0 1.4rem; }
  h1 { font-size:clamp(2.1rem,5.5vw,3.4rem); line-height:1.08; margin:0 0 1rem; font-weight:600;
    letter-spacing:-.015em; text-wrap:balance; }
  .subtitlu { font-size:1.12rem; color:var(--ink-2); margin:0; max-width:40rem; text-wrap:pretty; }
  .teza { border-left:3px solid var(--verde); padding:.2rem 0 .2rem 1.3rem; margin:2.5rem 0 3rem;
    max-width:44rem; }
  .teza p { margin:0 0 .8rem; } .teza p:last-child { margin-bottom:0; }
  .doua { display:grid; grid-template-columns:1fr 1fr; border:1px solid var(--rule);
    background:var(--card); margin:0 0 3.5rem; }
  .doua > div { padding:1.1rem 1.3rem; }
  .doua > div + div { border-left:1px solid var(--rule); }
  .doua h3 { font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; font-size:.7rem;
    letter-spacing:.13em; text-transform:uppercase; color:var(--ink-3); margin:0 0 .5rem; font-weight:600; }
  .doua p { margin:0; font-size:.97rem; color:var(--ink-2); }
  @media (max-width:34rem) { .doua { grid-template-columns:1fr; }
    .doua > div + div { border-left:0; border-top:1px solid var(--rule); } }
  .parte { margin:0 0 2.75rem; }
  .parte-cap { display:flex; align-items:baseline; gap:.9rem; border-bottom:1px solid var(--rule-2);
    padding-bottom:.5rem; margin-bottom:.2rem; flex-wrap:wrap; }
  .parte-nr { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size:.72rem;
    letter-spacing:.08em; color:var(--verde); text-transform:uppercase; flex:0 0 auto; }
  .parte-cap h2 { font-size:1.32rem; margin:0; font-weight:600; letter-spacing:-.01em;
    text-wrap:balance; flex:1 1 auto; }
  .faza { font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; font-size:.68rem;
    letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); flex:0 0 auto; }
  .rezumat { font-size:.97rem; color:var(--ink-2); margin:.7rem 0 .9rem; max-width:46rem;
    text-wrap:pretty; }
  .randuri { border-top:1px solid var(--rule); }
  .rand { display:grid; grid-template-columns:3.1rem 1fr; gap:0 .9rem; padding:.5rem .7rem;
    border-bottom:1px solid var(--rule); align-items:baseline; }
  .rand:nth-child(even) { background:var(--bar); }
  .nr { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size:.82rem;
    color:var(--ink-3); font-variant-numeric:tabular-nums; text-align:right; }
  .titlu { margin:0; } .titlu b { font-weight:600; }
  .nota { display:block; font-size:.9rem; color:var(--ink-2); margin-top:.12rem; text-wrap:pretty; }
  .rand.semn .nr, .rand.semn .titlu b { color:var(--rosu); }
  .subsol { margin-top:4rem; padding-top:1.5rem; border-top:2px solid var(--ink); font-size:.92rem;
    color:var(--ink-2); display:grid; gap:.6rem; }
  .subsol strong { color:var(--ink); font-weight:600; }

  .capitol { margin:4rem 0 0; padding-top:2.5rem; border-top:2px solid var(--ink); }
  .cap-parte { font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; font-size:.7rem;
    letter-spacing:.13em; text-transform:uppercase; color:var(--verde); margin:0 0 .3rem; font-weight:600; }
  .cap-nr { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size:.78rem;
    color:var(--ink-3); margin:0 0 .4rem; }
  .cap-titlu { font-size:clamp(1.7rem,4vw,2.4rem); line-height:1.14; margin:0 0 1.8rem;
    font-weight:600; letter-spacing:-.012em; text-wrap:balance; }
  .capitol p { max-width:38rem; margin:0 0 1.05rem; }
  .capitol h3 { font-size:1.18rem; font-weight:600; margin:2.4rem 0 .8rem; text-wrap:balance; }
  .cheie { border-left:3px solid var(--verde); padding-left:1rem; font-style:italic;
    color:var(--verde); font-weight:600; margin:1.4rem 0 1.6rem !important; }
  .contabil { border:1px solid var(--rule); background:var(--card); padding:1.1rem 1.3rem;
    margin:2rem 0; max-width:40rem; }
  .contabil h4 { font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; font-size:.7rem;
    letter-spacing:.13em; text-transform:uppercase; color:var(--ink-3); margin:0 0 .5rem; font-weight:600; }
  .contabil p { margin:0 !important; font-size:.95rem; color:var(--ink-2); }
  .recap { border-top:2px solid var(--verde); padding-top:1rem; margin:2.6rem 0 0; max-width:40rem; }
  .recap h4 { font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; font-size:.7rem;
    letter-spacing:.13em; text-transform:uppercase; color:var(--verde); margin:0 0 .7rem; font-weight:600; }
  .recap ul { margin:0; padding-left:1.1rem; }
  .recap li { margin:0 0 .5rem; }
  .tab { margin:1.6rem 0 1.8rem; max-width:40rem; overflow-x:auto; }
  .tab figcaption { font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
    font-size:.7rem; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3);
    margin:0 0 .5rem; font-weight:600; }
  .tab table { border-collapse:collapse; width:100%; font-size:.95rem; }
  .tab th { text-align:left; background:var(--bar); font-weight:600; }
  .tab th, .tab td { border-top:1px solid var(--rule); border-bottom:1px solid var(--rule);
    padding:.42rem .6rem; }
  .tab th.num, .tab td.num { text-align:right; }
  .tab td.num { font-variant-numeric:tabular-nums; }
  .tab tbody tr.total td { font-weight:600; }
  .tab-nota { font-size:.88rem; color:var(--ink-2); margin:.6rem 0 0 !important; font-style:italic; }
</style></head><body><div class="foaie">
<header class="antet">
  <p class="eticheta">Cuprins · carte de prezentare</p>
  <h1>${esc(D.titlu)}</h1>
  <p class="subtitlu">${esc(D.subtitlu)}</p>
</header>
<div class="teza">${D.teza.map((t) => `<p>${esc(t)}</p>`).join('')}</div>
<div class="doua">${D.doua.map((c) => `<div><h3>${esc(c.cap)}</h3><p>${esc(c.txt)}</p></div>`).join('')}</div>
${parti}
<footer class="subsol">${D.subsol.map((s) => `<p><strong>${esc(s.cap)}</strong> — ${esc(s.txt)}</p>`).join('')}</footer>
${CAPITOLE.map(blocuriHtml).join('\n')}
</div></body></html>`;
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

// HTML-ul de CITIT: livrabil, se descarca si se deschide in orice browser, si offline.
const htmlEcran = path.join(IESIRE, 'Cuprins-carte-contabilitate.html');
fs.writeFileSync(htmlEcran, faHtmlEcran(), 'utf8');
fs.chmodSync(htmlEcran, 0o644);
console.log(`   .html  ${(fs.statSync(htmlEcran).size / 1024).toFixed(1)} KB  ${path.relative(RADACINA, htmlEcran)}`);

// HTML-ul de TIPAR ramane intermediar (in tmp): exista doar ca sa iasa PDF-ul din el.
const htmlCale = path.join(os.tmpdir(), `${NUME}-tipar.html`);
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
