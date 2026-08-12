'use strict';

// Fundatia PDF-urilor (pdfkit): culori (C), document nou, antet cu logo, tabel generic,
// subsol, finish (stream catre res) + recapPdf, sablonul de recapitulatie refolosit de
// declaratii si salarii. Scos din vechiul src/pdf.js monolit.

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Logo-ul firmei (optional): incarcat in Setari -> Date firma, stocat in uploads/.
// Rezolvarea cai se face aici ca sa nu depindem de server in restul functiilor.
//
// `../db`, NU `./db`. Functia a venit din monolitul `src/pdf.js`, unde fratele ei chiar era
// `src/db.js`; mutata in `src/pdf/`, aceeasi cale a inceput sa arate spre `src/pdf/db` —
// inexistent. `require` arunca MODULE_NOT_FOUND, `catch`-ul de mai jos il inghitea, iar functia
// raspundea `null` linistit: 26 de zile in care logo-ul incarcat de utilizator n-a aparut pe
// NICIUN PDF si pe nicio factura, fara o linie in log. Fumul HTTP n-avea cum sa vada — un PDF
// fara logo e tot un PDF valid, cu acelasi `%PDF` la inceput.
//
// `catch`-ul ramane (un logo ilizibil nu are voie sa rupa o factura), dar acum e pazit din doua
// parti: o poarta care refuza orice `require` relativ nerezolvabil din `src/` si o proba pe EFECT
// (fisier real pe disc -> cale intoarsa, si logo-ul chiar ajunge in PDF). Vezi test/pdf.js.
function logoPath(company) {
  if (!company || !company.logoFile) return null;
  try {
    const safe = String(company.logoFile).replace(/[^a-zA-Z0-9._-]/g, '');
    if (!/\.(png|jpe?g)$/i.test(safe)) return null; // PDFKit accepta doar PNG/JPEG
    const p = path.join(require('../db').UPLOAD_DIR, safe);
    return fs.existsSync(p) ? p : null;
  } catch (e) { return null; }
}

/** Inlocuieste diacriticele si caracterele neacceptate de fonturile standard. */

/** Inlocuieste diacriticele si caracterele neacceptate de fonturile standard. */
function clean(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[ăâ]/g, 'a').replace(/[ĂÂ]/g, 'A')
    .replace(/[îí]/g, 'i').replace(/[ÎÍ]/g, 'I')
    .replace(/[șşśš]/g, 's').replace(/[ȘŞŚŠ]/g, 'S')
    .replace(/[țţ]/g, 't').replace(/[ȚŢ]/g, 'T')
    .replace(/[“”„]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-')
    // pastreaza doar caractere imprimabile Latin-1
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
}

const C = {
  ink: '#1a1a2e',
  muted: '#555',
  line: '#cfd3dc',
  head: '#2b3a67',
  headText: '#ffffff',
  zebra: '#f3f5fa',
  accent: '#0b6e4f',
  danger: '#b00020',
};

function newDoc(landscape) {
  return new PDFDocument({
    size: 'A4',
    layout: landscape ? 'landscape' : 'portrait',
    margins: { top: 48, bottom: 48, left: 40, right: 40 },
    bufferPages: true,
    info: { Title: 'Document contabil', Author: 'Contabo' },
  });
}

function header(doc, company, title, subtitle) {
  const left = doc.page.margins.left;
  if (company) doc._company = company; // pentru footer (subsol personalizat)
  const accent = (company && /^#[0-9a-fA-F]{6}$/.test(company.accentColor || '')) ? company.accentColor : C.accent;
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(15).text(clean(title), left, 40);
  if (subtitle) doc.fillColor(C.muted).font('Helvetica').fontSize(10).text(clean(subtitle), left, doc.y + 1);
  doc.moveDown(0.2);
  const right = doc.page.width - doc.page.margins.right;
  doc.fillColor(C.muted).font('Helvetica').fontSize(9);
  let cy = 40;
  const lp = logoPath(company);
  if (lp) {
    try { doc.image(lp, right - 130, 34, { fit: [130, 38] }); cy = 78; } catch (e) { /* logo corupt -> fara logo */ }
  }
  doc.text(clean(company.nume || ''), left, cy, { width: right - left, align: 'right' });
  const meta = [company.cui ? 'CUI ' + company.cui : '', company.regCom || ''].filter(Boolean).join('  •  ');
  if (meta) doc.text(clean(meta), left, doc.y, { width: right - left, align: 'right' });
  const contact = [company.iban ? 'IBAN ' + company.iban : '', company.telefon || '', company.email || ''].filter(Boolean).join('  •  ');
  if (contact) doc.text(clean(contact), left, doc.y, { width: right - left, align: 'right' });
  doc.moveDown(0.6);
  doc.strokeColor(accent).lineWidth(1.6).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
  doc.moveDown(0.6);
  return doc.y;
}

/**
 * Tabel generic.
 * columns: [{ label, width, align, key }]
 * rows: [{ key: value, _bold, _accent, _fill }]
 */

/**
 * Tabel generic.
 * columns: [{ label, width, align, key }]
 * rows: [{ key: value, _bold, _accent, _fill }]
 */
function table(doc, columns, rows, startY) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  const scale = (right - left) / totalW;
  columns.forEach((c) => { c._w = c.width * scale; });

  let y = startY != null ? startY : doc.y;
  const rowH = 16;
  const bottom = doc.page.height - doc.page.margins.bottom;

  function drawHead() {
    doc.rect(left, y, right - left, rowH + 2).fill(C.head);
    doc.fillColor(C.headText).font('Helvetica-Bold').fontSize(8.5);
    let x = left;
    for (const c of columns) {
      doc.text(clean(c.label), x + 4, y + 4, { width: c._w - 8, align: c.align || 'left', lineBreak: false });
      x += c._w;
    }
    y += rowH + 2;
  }

  drawHead();
  doc.font('Helvetica').fontSize(8.5);
  let zebra = false;
  for (const r of rows) {
    // estimeaza inaltimea (explicatii lungi pot ocupa 2 randuri)
    let h = rowH;
    for (const c of columns) {
      const txt = clean(r[c.key] != null ? r[c.key] : '');
      if (c.wrap && txt) {
        const hh = doc.heightOfString(txt, { width: c._w - 8 });
        h = Math.max(h, hh + 6);
      }
    }
    if (y + h > bottom) { doc.addPage(); y = doc.page.margins.top; drawHead(); doc.font('Helvetica').fontSize(8.5); }

    if (r._fill || zebra) doc.rect(left, y, right - left, h).fill(r._fill || C.zebra);
    doc.fillColor(r._accent ? C.accent : C.ink).font(r._bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    let x = left;
    for (const c of columns) {
      const val = r[c.key];
      const txt = clean(val != null ? val : '');
      doc.text(txt, x + 4, y + 4, { width: c._w - 8, align: c.align || 'left', lineBreak: !!c.wrap });
      x += c._w;
    }
    doc.strokeColor(C.line).lineWidth(0.5).moveTo(left, y + h).lineTo(right, y + h).stroke();
    y += h;
    zebra = !zebra;
  }
  doc.y = y + 6;
  return y;
}

function footer(doc) {
  const range = doc.bufferedPageRange();
  const note = (doc._company && doc._company.pdfFooter) ? clean(String(doc._company.pdfFooter)).slice(0, 200) : '';
  // intocmitorul (datele personale ale utilizatorului abonat) — pe fiecare pagina
  const who = (doc._company && doc._company._intocmit) ? clean('Intocmit: ' + String(doc._company._intocmit)).slice(0, 120) : '';
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const b = doc.page.margins.bottom;
    const w = doc.page.width;
    if (note) doc.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(note, 40, doc.page.height - b + 4, { width: w - 80, align: 'center', lineBreak: false });
    doc.fillColor(C.muted).font('Helvetica').fontSize(7.5);
    if (who) doc.text(who, 40, doc.page.height - b + 4, { width: w - 260, align: 'left', lineBreak: false });
    doc.text('Generat de Contabo • cifre conform inregistrarilor din aplicatie',
      40, doc.page.height - b + 14, { align: 'left', lineBreak: false });
    doc.text('Pagina ' + (i + 1) + ' / ' + range.count,
      w - 140, doc.page.height - b + 14, { width: 100, align: 'right', lineBreak: false });
  }
}

function finish(doc, res, filename) {
  footer(doc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
  doc.pipe(res);
  doc.end();
}

// ───────────────────────────── RAPOARTE ─────────────────────────────

/**
 * Raport recapitulativ generic: titlu + (optional) randuri de identificare + tabel + nota.
 *
 * `opts.intro` (lista de siruri) exista fiindca `recapPdf` isi construieste PROPRIUL document si
 * il si inchide (`finish`). Un apelant care voia sa scrie ceva inaintea tabelului nu avea unde:
 * fluturasul isi facea un `newDoc()` al lui, scria acolo „Angajat:" si „CNP:", apoi delega aici —
 * iar documentul lui ramanea ORFAN, nefinalizat. Randurile acelea n-au ajuns niciodata pe hartie,
 * tacut, fiindca `%PDF` era tot acolo si numele angajatului venea oricum din `subtitle`.
 */
function recapPdf(res, company, opts) {
  const doc = newDoc(false);
  header(doc, company, opts.title, opts.subtitle);
  const intro = (opts.intro || []).filter(Boolean);
  if (intro.length) {
    doc.fillColor(C.ink).font('Helvetica').fontSize(10);
    for (const linie of intro) doc.text(clean(linie));
    doc.moveDown(0.5);
  }
  table(doc, [
    { label: opts.colName || 'Indicator', key: 'k', width: 330 },
    { label: opts.colVal || 'Suma (lei)', key: 'v', width: 150, align: 'right' },
  ], opts.rows);
  if (opts.note) {
    doc.moveDown(0.6);
    doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(clean(opts.note));
  }
  finish(doc, res, opts.filename || 'raport.pdf');
}


module.exports = { logoPath, clean, C, newDoc, header, table, footer, finish, recapPdf };
