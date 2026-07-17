'use strict';

// Listele de inregistrari (recente/intrate/iesite), actiunile pe rand, documentele lipsa, arhiva.
// Extras din app.js (faza 2); apelurile inapoi spre app.js vin prin setDeps (fara cicluri).
import { $$, $, H, fmt, toast, api, META, setMeta } from './core.js';
import { pget, workMonth, lunaLabel, onPeriodChange, fillPeriods } from './periods.js';

const D = { goTab: null };
function setEntriesDeps(d) { Object.assign(D, d); }

const EFACT_TYPES = new Set(['factura_vanzare_marfuri', 'factura_vanzare_produse', 'factura_vanzare_servicii', 'livrare_intracomunitara', 'factura_storno_vanzare', 'factura_storno_cumparare']);
const SENDABLE_TYPES = new Set(['factura_vanzare_marfuri', 'factura_vanzare_produse', 'factura_vanzare_servicii', 'livrare_intracomunitara', 'factura_storno_vanzare']);
// $, $$ mutati in core.js (importate mai sus)
// Buton „arată/ascunde" pe fiecare camp de parola (login, inscriere, schimbare parola, admin…)
function entryDir(tip) {
  const t = (META.types || []).find((x) => x.id === tip);
  const grup = t ? t.grup : '';
  if (grup === 'Vanzari' || /vanzare|^livrare_intra|^bon_fiscal/.test(tip)) return 'out';
  if (grup === 'Cumparari' || /cumparare/.test(tip)) return 'in';
  return 'other';
}
function entryRowHtml(e) {
  const formula = e.lines.map((l) => `${l.debit}=${l.credit}`).join(', ');
  const total = e.lines.reduce((s, l) => s + l.suma, 0);
  return `<tr class="${e.system ? 'sys' : ''}">
    <td>${H(e.data)}</td>
    <td>${H(e.tipNume)}${e.system ? ' <span class="pill">auto</span>' : ''}</td>
    <td>${H(e.partener)}</td>
    <td class="acc">${H(formula)}</td>
    <td class="num">${fmt(total)}</td>
    <td><a class="linkbtn" href="/pdf/note/${e.id}" target="_blank">PDF</a>
        ${e.lines.some((l) => /^531/.test(String(l.debit))) ? ` · <a class="linkbtn" href="/pdf/chitanta/${e.id}" target="_blank" title="Chitanta pentru incasarea in numerar (numar din seria CH)">chitanță</a>` : ''}
        ${EFACT_TYPES.has(e.tip) ? ` · <a class="linkbtn" href="/xml/efactura/${e.id}" target="_blank">e-Factura</a>` : ''}
        ${SENDABLE_TYPES.has(e.tip) ? (e.spv
    ? ` · <button class="linkbtn spvstat" data-id="${e.id}">SPV: ${e.spv.stare}${e.spv.acceptat ? ' ✓' : ''}</button>${e.spv.idDescarcare ? ` · <button class="linkbtn spvdl" data-id="${e.id}">recipisă</button>` : ''}`
    : ` · <button class="linkbtn spvsend" data-id="${e.id}">trimite SPV</button>`) : ''}
        ${e.fileId ? ` · <a class="linkbtn" href="/api/document/${e.fileId}/file" target="_blank">doc</a>` : ''}</td>
    <td><button class="del" data-id="${e.id}" title="Șterge">✕</button></td>
  </tr>`;
}
function renderEntryTable(containerId, rowsHtml, emptyMsg) {
  const el = $('#' + containerId); if (!el) return;
  if (!rowsHtml) { el.innerHTML = `<p class="muted">${emptyMsg}</p>`; return; }
  el.innerHTML = `<table><thead><tr>
    <th>Data</th><th>Tip</th><th>Partener</th><th>Formulă</th><th class="num">Sumă</th><th>Fișiere</th><th></th>
    </tr></thead><tbody>${rowsHtml}</tbody></table>`;
  bindEntryActions(el);
}
function bindEntryActions(root) {
  root.querySelectorAll('.del').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi această înregistrare?')) return;
    await api('/api/entries/' + b.dataset.id, { method: 'DELETE' });
    toast('Înregistrare ștearsă');
    setMeta(await api('/api/meta')); fillPeriods(); loadEntries();
  }));
  root.querySelectorAll('.spvsend').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'se trimite…';
    try { const r = await api('/api/anaf/send/' + b.dataset.id, { method: 'POST' }); toast('Trimis în SPV (index ' + r.spv.index + ')'); loadEntries(); }
    catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'trimite SPV'; }
  }));
  root.querySelectorAll('.spvstat').forEach((b) => b.addEventListener('click', async () => {
    try { const r = await api('/api/anaf/status/' + b.dataset.id, { method: 'POST' }); toast('Stare SPV: ' + r.spv.stare + (r.spv.acceptat ? ' (acceptată)' : '')); loadEntries(); }
    catch (e) { toast(e.message, true); }
  }));
  root.querySelectorAll('.spvdl').forEach((b) => b.addEventListener('click', async () => {
    try { const r = await api('/api/anaf/download/' + b.dataset.id, { method: 'POST' }); toast('Recipisă descărcată'); window.open('/api/document/' + r.documentId + '/file', '_blank'); loadEntries(); }
    catch (e) { toast(e.message, true); }
  }));
}
let ENTRIES_CACHE = [];
function inPeriodClient(e, period) {
  if (!period) return true;
  return (e.period || (e.data || '').slice(0, 7)).startsWith(period);
}
async function loadEntries() {
  ENTRIES_CACHE = await api('/api/entries');
  renderEntryLists();
}
function renderEntryLists() {
  const ordered = ENTRIES_CACHE.slice().reverse();
  // 📥 intrate (filtrate pe Lună+An)
  const pi = pget('intrate');
  let intr = ordered.filter((e) => entryDir(e.tip) === 'in');
  if (pi) intr = intr.filter((e) => inPeriodClient(e, pi));
  if ($('#countIntrare')) $('#countIntrare').textContent = intr.length + ' documente';
  renderEntryTable('entriesIntrare', intr.map(entryRowHtml).join(''), 'Niciun document de intrare în perioada aleasă.');
  // 📤 ieșite
  const po = pget('iesite');
  let ies = ordered.filter((e) => entryDir(e.tip) === 'out');
  if (po) ies = ies.filter((e) => inPeriodClient(e, po));
  if ($('#countIesire')) $('#countIesire').textContent = ies.length + ' documente';
  renderEntryTable('entriesIesire', ies.map(entryRowHtml).join(''), 'Niciun document de ieșire în perioada aleasă.');
  // toate
  const pt = pget('toate');
  let toate = ordered;
  if (pt) toate = toate.filter((e) => inPeriodClient(e, pt));
  if ($('#entriesCount')) $('#entriesCount').textContent = toate.length + ' înregistrări';
  renderEntryTable('entriesList', toate.map(entryRowHtml).join(''), 'Nicio înregistrare în perioada aleasă.');
}
onPeriodChange('intrate', renderEntryLists);
onPeriodChange('iesite', renderEntryLists);
onPeriodChange('toate', renderEntryLists);
async function loadMissingDocs() {
  const el = $('#missingDocs'); if (!el) return;
  let p = pget('intrate');
  if (!/^\d{4}-\d{2}$/.test(p)) p = workMonth(); // analiza e lunară
  let d; try { d = await api('/api/missing-docs?period=' + p); } catch (e) { el.innerHTML = ''; return; }
  const lbl = lunaLabel(d.period);
  const alert = d.missing.length || d.countThis < d.avgPrev;
  el.innerHTML = `<div class="missingbox${alert ? '' : ' ok'}">
    <span class="wi">${alert ? '⚠️' : '✅'}</span>
    <div><b>${lbl}:</b> ${d.countThis} documente intrate · media ultimelor 3 luni: <b>${d.avgPrev}</b>${d.countThis < d.avgPrev ? ' <span class="muted">(sub medie — verifică ce lipsește)</span>' : ''}
      ${d.missing.length
    ? `<div data-u="u23"><b>Posibil lipsă</b> — furnizori care apăreau lunar, dar fără document în ${lbl}:</div>
           <ul class="checklist todo" data-u="u27">${d.missing.map((m) => `<li>${m.partener} <span class="muted">— ultima oară: ${lunaLabel(m.ultimaLuna)} · ${m.luniPrezent}/3 luni anterioare</span></li>`).join('')}</ul>`
    : '<div data-u="u18">✓ Nu pare să lipsească niciun document recurent.</div>'}
    </div></div>`;
}
async function loadArhiva() {
  const p = pget('arhiva') || workMonth();
  const monthly = /^\d{4}-\d{2}$/.test(p);
  const yr = p.slice(0, 4);
  const pq = '?period=' + p; const yq = '?year=' + yr;
  const all = await api('/api/entries');
  const inPer = (e) => (e.period || (e.data || '').slice(0, 7)).startsWith(p);
  const intr = all.filter((e) => entryDir(e.tip) === 'in' && inPer(e));
  const ies = all.filter((e) => entryDir(e.tip) === 'out' && inPer(e));
  const total = (e) => fmt(e.lines.reduce((s, l) => s + l.suma, 0));
  const row = (e, extra) => `<tr><td>${H(e.data)}</td><td>${H(e.tipNume)}</td><td>${H(e.partener)}</td><td class="num">${total(e)}</td>
    <td><a class="linkbtn" href="/pdf/note/${e.id}" target="_blank">PDF</a>${e.fileId ? ` · <a class="linkbtn" href="/api/document/${e.fileId}/file" target="_blank">doc</a>` : ''}${extra ? extra(e) : ''}</td></tr>`;
  const tbl = (arr, extra, empty) => arr.length
    ? `<table><thead><tr><th>Data</th><th>Document</th><th>Partener</th><th class="num">Sumă</th><th>Fișiere</th></tr></thead><tbody>${arr.map((e) => row(e, extra)).join('')}</tbody></table>`
    : `<p class="muted">${empty}</p>`;
  const L = (href, label) => `<a class="btn small arh-link" href="${href}" target="_blank">${label}</a>`;
  const G = (tab, label) => `<button class="btn small arh-link" data-go="${tab}">${label}</button>`;
  const eFact = (e) => (EFACT_TYPES.has(e.tip) ? ` · <a class="linkbtn" href="/xml/efactura/${e.id}" target="_blank">e-Factura</a>` : '');
  const declMonthly = L('/pdf/d300' + pq, '⬇ D300 PDF') + L('/xml/d300' + pq, 'D300 XML') + L('/xml/d394' + pq, 'D394 XML') + L('/xml/d390' + pq, 'D390 XML (VIES)') + L('/xml/d100' + pq, 'D100 XML (trim.)') + L('/csv/intrastat' + pq, 'Intrastat CSV') + L('/xml/intrastat' + pq, 'Intrastat XML') + L('/pdf/d112' + pq, '⬇ D112 PDF') + L('/xml/d112' + pq, 'D112 XML') + L('/xml/d205' + yq, 'D205 XML (an)') + L('/xml/saft' + yq, 'SAF-T XML');
  $('#arhivaView').innerHTML = `
    <div class="card"><h3>📥 01 · Intrări (facturi primite)</h3>
      <p class="muted">Facturi de la furnizori, bonuri, chitanțe — cu fișierul scanat atașat.</p>${tbl(intr, null, 'Niciun document de intrare în perioadă.')}</div>
    <div class="card"><h3>📤 02 · Ieșiri (facturi emise)</h3>
      <p class="muted">Facturi către clienți — cu PDF și e-Factura.</p>${tbl(ies, eFact, 'Niciun document de ieșire în perioadă.')}</div>
    <div class="grid2">
      <div class="card"><h3>🏦 03 · Bancă</h3><p class="muted">Jurnalul de bancă (5121) și extrasele importate.</p>${G('cashbook', 'Deschide Bancă / Casă')}</div>
      <div class="card"><h3>💵 04 · Casă</h3><p class="muted">Registrul de casă (5311) — încasări/plăți în numerar.</p>${G('cashbook', 'Deschide Bancă / Casă')}</div>
    </div>
    <div class="card"><h3>👥 05 · Salarii</h3>
      <p class="muted">State de plată și declarația D112.</p>${monthly ? L('/pdf/stat-plata' + pq, '⬇ Stat de plată PDF') + L('/xml/d112' + pq, 'D112 XML') : '<span class="muted">Alege o lună pentru statul de plată.</span>'}</div>
    <div class="card"><h3>🧾 06 · Declarații ANAF</h3>
      <p class="muted">Declarațiile fiscale ale perioadei.${monthly ? '' : ' <b>Alege o lună</b> pentru declarațiile lunare (D300/D394/D112).'}</p>${monthly ? declMonthly : L('/xml/saft' + yq, 'SAF-T XML (an întreg)')}
      ${monthly ? `<div data-u="u23"><button id="validateDecl" class="btn small" data-p="${p}" data-yr="${yr}">🔍 Verifică declarațiile (pre-depunere)</button><div id="validateResult" data-u="u18"></div></div>` : ''}
      <p class="muted" data-u="u28">⚠️ Ciorne — verificarea de mai sus prinde erorile frecvente, dar validează final cu <b>DUKIntegrator</b> / XSD ANAF înainte de depunere.</p></div>
    <div class="card"><h3>📚 07 · Registre & Bilanț</h3>
      <p class="muted">Registrele obligatorii și situațiile financiare.</p>
      ${L('/pdf/journal' + pq, '⬇ Registru-jurnal PDF')}${L('/csv/journal' + pq, 'Jurnal CSV')}${L('/pdf/ledger' + pq, '⬇ Cartea mare PDF')}${L('/pdf/balance' + pq, '⬇ Balanță PDF')}${L('/csv/balance' + pq, 'Balanță CSV')}${L('/pdf/pl' + yq, '⬇ Cont P&P PDF')}${L('/pdf/bilant' + pq, '⬇ Bilanț PDF')}</div>`;
  $$('#arhivaView [data-go]').forEach((b) => b.addEventListener('click', () => D.goTab(b.dataset.go)));
  const vb = $('#validateDecl');
  if (vb) vb.addEventListener('click', async () => {
    vb.disabled = true; const out = $('#validateResult'); out.innerHTML = '<span class="muted">Se verifică…</span>';
    const types = [['d300', 'D300'], ['d394', 'D394'], ['d390', 'D390'], ['d112', 'D112']];
    const results = [];
    for (const [t, label] of types) {
      try { const r = await api('/api/validate/' + t + '?period=' + vb.dataset.p + '&year=' + vb.dataset.yr); results.push(Object.assign({ label }, r)); }
      catch (e) { results.push({ label, ok: false, errors: [e.message], warnings: [] }); }
    }
    out.innerHTML = results.map((r) => {
      const icon = r.ok ? (r.warnings.length ? '⚠️' : '✅') : '❌';
      const msgs = [...r.errors.map((m) => `<span data-u="u13">✗ ${m}</span>`), ...r.warnings.map((m) => `<span class="muted">⚠ ${m}</span>`)];
      return `<div data-u="u29"><b>${icon} ${r.label}</b>${msgs.length ? ': ' + msgs.join(' · ') : ' — fără probleme'}</div>`;
    }).join('');
    vb.disabled = false;
  });
}
onPeriodChange('arhiva', loadArhiva);

export { loadArhiva, loadEntries, loadMissingDocs, renderEntryLists, setEntriesDeps };
