'use strict';
// Vizualizatorul de documente in aplicatie (Etapa 8 a modularizarii frontendului): PDF/imagini
// in <iframe>, CSV/text si XML ANAF (D300/D394/D112/SAF-T) cu pretty-print, plus e-Factura UBL
// randata ca factura lizibila. Intercepteaza global click-urile pe link-urile /pdf, /csv, /xml
// si le deschide intr-un overlay same-origin, in loc de o fila noua. Autonom: nu exporta nimic
// catre app.js — se activeaza doar prin import (efect secundar: inregistrarea handler-elor la
// incarcare). Depinde doar de $ si toast din core.js.

import { $, toast, uiLocale } from './core.js';

let VIEWER_TEXT = '';
function openViewer(url, title) {
  $('#pdfTitle').textContent = title || 'Document';
  $('#pdfOpen').href = url; $('#pdfDownload').href = url;
  if ($('#pdfCopy')) $('#pdfCopy').classList.add('hidden');
  $('#viewerHtml').classList.add('hidden');
  $('#pdfFrame').classList.remove('hidden');
  $('#pdfFrame').src = url;
  $('#pdfModal').classList.remove('hidden');
}
function openViewerHtml(html, title, url) {
  $('#pdfTitle').textContent = title || 'Document';
  $('#pdfOpen').href = url; $('#pdfDownload').href = url;
  if ($('#pdfCopy')) $('#pdfCopy').classList.add('hidden');
  $('#pdfFrame').classList.add('hidden'); $('#pdfFrame').src = 'about:blank';
  $('#viewerHtml').innerHTML = html; $('#viewerHtml').classList.remove('hidden');
  $('#pdfModal').classList.remove('hidden');
}
// Vedere text simplu (ca în Notepad) — pentru CSV
async function openCsvViewer(url, title) {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let text = await res.text();
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // scoate BOM la afisare
    VIEWER_TEXT = text;
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    openViewerHtml(`<pre class="txtview">${esc(text)}</pre>`, title || 'Fișier CSV', url);
    if ($('#pdfCopy')) $('#pdfCopy').classList.remove('hidden');
  } catch (e) { window.open(url, '_blank'); }
}
function closeViewer() {
  const m = $('#pdfModal'); if (!m || m.classList.contains('hidden')) return false;
  m.classList.add('hidden'); $('#pdfFrame').src = 'about:blank'; return true;
}
// Parseaza UBL si construieste o factura lizibila (e-Factura)
async function openEfacturaViewer(url, title) {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML invalid');
    openViewerHtml(renderEfactura(doc), title || 'e-Factura', url);
  } catch (e) { openViewer(url, title || 'e-Factura'); } // fallback: XML brut in iframe
}
// Vizualizator XML ANAF (declaratii + SAF-T) — pretty-print + colorare usoara, in aplicatie
function prettyXml(xml) {
  try {
    let out = ''; let pad = 0;
    const s = xml.replace(/>\s+</g, '><').replace(/(>)(<)(\/*)/g, '$1\n$2$3');
    s.split('\n').forEach((ln) => {
      ln = ln.trim(); if (!ln) return;
      if (/^<\/\w/.test(ln)) pad = Math.max(pad - 1, 0);
      out += '  '.repeat(pad) + ln + '\n';
      if (/^<\w[^>]*>$/.test(ln) && !/^<\?/.test(ln) && !/\/>$/.test(ln)) pad += 1;
    });
    return out.trim() || xml;
  } catch (e) { return xml; }
}
function highlightXml(esc) {
  return esc
    .replace(/(&lt;[!?/]?)([\w:.-]+)/g, '$1<span class="xtag">$2</span>')
    .replace(/([\w:.-]+)(=)(&quot;[^&]*?&quot;)/g, '<span class="xattr">$1</span>$2<span class="xval">$3</span>');
}
function xmlTitle(href) {
  const m = (href || '').match(/\/xml\/([a-z0-9]+)/i);
  const map = {
    d300: 'D300 — Decont TVA (XML ANAF)',
    d301: 'D301 — Decont special TVA (XML ANAF)',
    d307: 'D307 — Ajustări TVA (XML ANAF)',
    d311: 'D311 — TVA cu cod anulat (XML ANAF)',
    d107: 'D107 — Beneficiarii sponsorizărilor (XML ANAF)',
    d394: 'D394 — Declarație informativă (XML ANAF)',
    d112: 'D112 — Salarii / contribuții (XML ANAF)',
    saft: 'SAF-T / D406 (XML ANAF)',
  };
  return (m && map[(m[1] || '').toLowerCase()]) || 'XML ANAF';
}
async function openXmlViewer(url) {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const pretty = prettyXml(await res.text());
    VIEWER_TEXT = pretty;
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    openViewerHtml(`<pre class="txtview xmlview">${highlightXml(esc(pretty))}</pre>`, xmlTitle(url), url);
    if ($('#pdfCopy')) $('#pdfCopy').classList.remove('hidden');
  } catch (e) { window.open(url, '_blank'); }
}
function renderEfactura(doc) {
  const root = doc.documentElement;
  const T = (el, tag) => { const x = el && el.getElementsByTagName(tag)[0]; return x ? x.textContent.trim() : ''; };
  const party = (sel) => doc.getElementsByTagName(sel)[0];
  const sup = party('cac:AccountingSupplierParty'); const cus = party('cac:AccountingCustomerParty');
  const pName = (p) => T(p, 'cbc:RegistrationName') || T(p, 'cbc:Name');
  const cur = T(root, 'cbc:DocumentCurrencyCode') || 'RON';
  const isCN = /CreditNote/.test(root.tagName);
  const lineTags = isCN ? 'cac:CreditNoteLine' : 'cac:InvoiceLine';
  const qtyTag = isCN ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity';
  const lines = [...doc.getElementsByTagName(lineTags)].map((ln) => ({
    nume: T(ln, 'cbc:Name'), qty: T(ln, qtyTag), pret: T(ln.getElementsByTagName('cac:Price')[0], 'cbc:PriceAmount'),
    val: T(ln, 'cbc:LineExtensionAmount'), cota: T(ln, 'cbc:Percent'),
  }));
  const tt = party('cac:TaxTotal');
  const baza = T(root, 'cbc:TaxExclusiveAmount'); const tva = T(tt, 'cbc:TaxAmount');
  const total = T(root, 'cbc:PayableAmount') || T(root, 'cbc:TaxInclusiveAmount');
  const esc = (s) => (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  // `cur` si `cota` vin din XML-ul FURNIZORULUI (cbc:DocumentCurrencyCode / cbc:Percent), la fel
  // ca denumirile — deci se escapeaza la fel. Suma trecuta prin Number() e deja inofensiva.
  const money = (v) => v ? Number(v).toLocaleString(uiLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + esc(cur) : '';
  const idDirect = (() => { for (const c of root.children) if (c.tagName === 'cbc:ID') return c.textContent.trim(); return ''; })();
  return `<div class="efact-doc">
    <div data-u="u191">
      <div><h3>${isCN ? 'Factură storno (CreditNote)' : 'Factură (e-Factura)'}</h3>
        <div class="muted">Serie/nr: <b>${esc(idDirect)}</b> · Data: <b>${esc(T(root, 'cbc:IssueDate'))}</b></div></div>
      <div class="pill">UBL · CIUS-RO</div>
    </div>
    <div class="efact-parties">
      <div><div class="lbl">Furnizor</div><b>${esc(pName(sup))}</b><br><span class="muted">CUI: ${esc(T(sup, 'cbc:CompanyID'))}</span></div>
      <div><div class="lbl">Cumpărător</div><b>${esc(pName(cus))}</b><br><span class="muted">CUI: ${esc(T(cus, 'cbc:CompanyID'))}</span></div>
    </div>
    <table><thead><tr><th>Denumire</th><th class="num">Cant.</th><th class="num">Preț</th><th class="num">Cotă</th><th class="num">Valoare</th></tr></thead>
      <tbody>${lines.map((l) => `<tr><td>${esc(l.nume)}</td><td class="num">${esc(l.qty)}</td><td class="num">${money(l.pret)}</td><td class="num">${l.cota ? esc(l.cota) + '%' : '—'}</td><td class="num">${money(l.val)}</td></tr>`).join('')}</tbody>
    </table>
    <table class="efact-tot"><tbody>
      <tr><td>Bază impozabilă</td><td class="num">${money(baza)}</td></tr>
      <tr><td>TVA</td><td class="num">${money(tva)}</td></tr>
      <tr class="grand"><td>Total de plată</td><td class="num">${money(total)}</td></tr>
    </tbody></table>
  </div>`;
}
if ($('#pdfClose')) {
  $('#pdfClose').addEventListener('click', closeViewer);
  $('#pdfModal').addEventListener('click', (e) => { if (e.target.id === 'pdfModal') closeViewer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewer(); });
  if ($('#pdfCopy')) {
    $('#pdfCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(VIEWER_TEXT); toast('Copiat în clipboard'); }
      catch (e) { toast('Nu s-a putut copia', true); }
    });
  }
  // Intercepteaza link-urile -> deschide in aplicatie
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a'); if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/\/xml\/efactura\//.test(href)) { e.preventDefault(); openEfacturaViewer(a.href, 'e-Factura'); return; }
    if (/^\/xml\//.test(href)) { e.preventDefault(); openXmlViewer(a.href); return; }
    if (/^\/csv\//.test(href)) { e.preventDefault(); openCsvViewer(a.href, (a.textContent || '').replace(/[⬇\s]/g, ' ').trim() || 'Fișier CSV'); return; }
    if (/^\/pdf\//.test(href) || /\/api\/document\/[^/]+\/file/.test(href)) {
      e.preventDefault();
      openViewer(a.href, (a.textContent || '').trim() || a.getAttribute('title') || 'Document');
    }
  });
}

// Exportate pentru testele unitare de frontend (formatarea XML si titlul): test/frontend.mjs
export { prettyXml, xmlTitle };
