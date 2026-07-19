'use strict';

// Stocuri si gestiune: situatii, fise de magazie, documente de stoc, inventariere, productie. Extras din app.js (Etapa: spargerea fisierului mare).
import { $$, $, H, fmt, toast, api, fileToCsv, round2 } from './core.js';
import { pget, workMonth, onPeriodChange } from './periods.js';

// ───────────────────────── STOCURI ─────────────────────────
let STOCK_MOVS = [];
function stocAsOf() { return pget('stoc') || new Date().toISOString().slice(0, 7); }
function renderStockMovements() {
  const ft = $('#mvfTip').value, fg = $('#mvfGest').value, fl = $('#mvfLuna').value;
  const fx = ($('#mvfText').value || '').toLowerCase().trim();
  const movs = STOCK_MOVS.filter((m) => {
    if (ft && m.tip !== ft) return false;
    if (fg && m.gestiuneCod !== fg && m.gestiuneDestCod !== fg) return false;
    if (fl && String(m.data).slice(0, 7) !== fl) return false;
    if (fx && !((m.cod + ' ' + m.denumire + ' ' + (m.document || '') + ' ' + (m.operator || '')).toLowerCase().includes(fx))) return false;
    return true;
  });
  const tipLbl = (m) => m.tip === 'receptie' ? 'recepție' : m.tip === 'transfer' ? `transfer ${m.gestiuneCod}→${m.gestiuneDestCod}` : 'ieșire';
  $('#movementsList').innerHTML = movs.length
    ? `<table><thead><tr><th>Data</th><th>Tip</th><th>Gestiune</th><th>Produs</th><th class="num">Cantitate</th><th class="num">Preț</th><th>Document</th><th>Operator</th><th>Notă contabilă</th><th></th></tr></thead><tbody>${
      movs.map((m) => `<tr><td>${H(m.data)}</td><td>${tipLbl(m)}</td><td>${H(m.gestiuneCod)}</td><td>${H(m.cod)} ${H(m.denumire)}</td>
        <td class="num">${fmt(m.cantitate)} ${H(m.um)}</td><td class="num">${m.pretUnitar ? fmt(m.pretUnitar) : '—'}</td><td>${H(m.document)}</td><td>${m.operator ? H(m.operator) : '—'}</td>
        <td>${m.tip === 'transfer' ? '<span class="muted">intern</span>' : m.initial ? '<span class="pill" title="Stoc preluat la deschidere — valoarea e în soldurile inițiale, nu se contabilizează separat">sold inițial</span>' : m.entryId ? '<span class="pill">✓ contabilizat</span>' : `<button class="linkbtn mpost" data-id="${m.id}">postează nota</button>`}</td>
        <td>${m.tip === 'receptie' ? `<a class="linkbtn" href="/pdf/nir?id=${m.id}" target="_blank">NIR</a> · ` : m.tip === 'iesire' ? `<a class="linkbtn" href="/pdf/bon-consum?id=${m.id}" target="_blank">bon consum</a> · ` : `<a class="linkbtn" href="/pdf/aviz?id=${m.id}" target="_blank">aviz</a> · `}<button class="linkbtn mdel" data-id="${m.id}">șterge</button></td></tr>`).join('')}</tbody></table>
      <p class="muted" data-u="u18">${movs.length} din ${STOCK_MOVS.length} mișcări. „Postează nota”: recepție <b>3xx = 401</b>, ieșire <b>60x = 3xx</b> la CMP. Transferul e mișcare internă.</p>`
    : '<p class="muted">Nicio mișcare (verifică filtrele).</p>';
  $$('#movementsList .mdel').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/stock-movements/' + b.dataset.id, { method: 'DELETE' }); loadStocks(); toast('Mișcare ștearsă');
  }));
  $$('#movementsList .mpost').forEach((b) => b.addEventListener('click', async () => {
    try { const r = await api('/api/stock-movements/' + b.dataset.id + '/post', { method: 'POST' }); toast('Notă contabilă generată: ' + r.entry.lines[0].debit + ' = ' + r.entry.lines[0].credit + ' (' + fmt(r.entry.lines[0].suma) + ')'); loadStocks(); }
    catch (err) { toast(err.message, true); }
  }));
}
['#mvfTip', '#mvfGest', '#mvfLuna'].forEach((s) => $(s).addEventListener('change', renderStockMovements));
$('#mvfText').addEventListener('input', renderStockMovements);
$('#mvfReset').addEventListener('click', () => { $('#mvfTip').value = ''; $('#mvfGest').value = ''; $('#mvfText').value = ''; $('#mvfLuna').value = ''; renderStockMovements(); });
async function loadStocks() {
  const asOf = stocAsOf();
  const gf = $('#stocGestFilter').value;
  $('#stocPdf').href = '/pdf/stocks?asOf=' + asOf;
  $('#stocCsv').href = '/csv/stocks?asOf=' + asOf + (gf ? '&gestiune=' + gf : '');
  $('#movCsv').href = '/csv/stock-movements';
  const perioadaStoc = /^\d{4}-\d{2}$/.test(asOf) ? asOf : String(asOf).slice(0, 7);
  $('#aprovPdf') && ($('#aprovPdf').href = '/pdf/aprovizionari?period=' + perioadaStoc);
  $('#consumPdf') && ($('#consumPdf').href = '/pdf/consumuri?period=' + perioadaStoc);
  const [products, gestiuni, stock, movs] = await Promise.all([
    api('/api/products'), api('/api/gestiuni'), api('/api/stocks?asOf=' + asOf + (gf ? '&gestiune=' + gf : '')), api('/api/stock-movements'),
  ]);
  // gestiuni: listă + selecturi
  $('#gestiuniList').innerHTML = gestiuni.length
    ? `<table><thead><tr><th>Cod</th><th>Denumire</th><th>Gestionar</th><th>Cont</th><th></th></tr></thead><tbody>${
      gestiuni.map((g) => `<tr><td class="acc">${H(g.cod)}</td><td>${H(g.denumire)}</td><td>${H(g.gestionar)}</td><td class="acc">${H(g.cont || '371')}</td>
        <td><button class="linkbtn gdel" data-id="${g.id}">șterge</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio gestiune. Adaugă cel puțin un depozit.</p>';
  $$('#gestiuniList .gdel').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/gestiuni/' + b.dataset.id, { method: 'DELETE' }); loadStocks(); toast('Gestiune ștearsă'); }
    catch (e) { toast(e.message, true); }
  }));
  const gestOpts = gestiuni.map((g) => `<option value="${g.id}">${H(g.cod)} — ${H(g.denumire)}</option>`).join('');
  const mf = $('#movementForm');
  mf.productId.innerHTML = products.map((p) => `<option value="${p.id}">${H(p.cod)} — ${H(p.denumire)}</option>`).join('') || '<option value="">(niciun produs)</option>';
  mf.gestiuneId.innerHTML = gestOpts || '<option value="">(nicio gestiune)</option>';
  mf.gestiuneDestId.innerHTML = gestOpts || '<option value="">(nicio gestiune)</option>';
  $('#stocGestFilter').innerHTML = '<option value="">Toate gestiunile</option>' + gestiuni.map((g) => `<option value="${g.id}"${g.id === gf ? ' selected' : ''}>${H(g.cod)} — ${H(g.denumire)}</option>`).join('');
  fillProduction(products, gestiuni);
  fillRecipes(products, gestiuni);
  const ig = $('#invGest'); const prevIg = ig.value;
  ig.innerHTML = gestiuni.map((g) => `<option value="${g.id}">${H(g.cod)} — ${H(g.denumire)}</option>`).join('') || '<option value="">(nicio gestiune)</option>';
  if (prevIg) ig.value = prevIg;
  $('#invPdf').href = '/pdf/inventory?asOf=' + asOf + '&gestiune=' + (ig.value || '');
  // stoc curent (pe gestiune)
  const totV = stock.reduce((t, s) => t + s.stocV, 0);
  $('#stocksList').innerHTML = stock.length
    ? `<table><thead><tr><th>Gestiune</th><th>Cod</th><th>Denumire</th><th class="num">Cantitate</th><th>UM</th><th class="num">CMP</th><th class="num">Valoare</th><th></th></tr></thead><tbody>${
      stock.map((s) => `<tr><td>${H(s.gestiune.cod)}</td><td class="acc">${H(s.product.cod)}</td><td>${H(s.product.denumire)}${s.product.activ === false ? ' <span class="badge" title="Produs dezactivat — nu mai primește mișcări noi">inactiv</span>' : ''}</td>
        <td class="num">${fmt(s.stocQ)}</td><td>${H(s.product.um || 'buc')}</td><td class="num">${fmt(s.cmp)}</td><td class="num">${fmt(s.stocV)}</td>
        <td><a class="linkbtn" href="/pdf/stock-ledger/${s.product.id}?asOf=${asOf}&gestiune=${s.gestiune.id}" target="_blank">fișă</a> · <button class="linkbtn pdel" data-id="${s.product.id}">șterge</button> · <button class="linkbtn ptoggle" data-id="${s.product.id}" data-activ="${s.product.activ === false ? '0' : '1'}">${s.product.activ === false ? 'reactivează' : 'dezactivează'}</button></td></tr>`).join('')}
      <tr class="bold"><td colspan="6">TOTAL VALOARE STOC</td><td class="num">${fmt(round2(totV))}</td><td></td></tr></tbody></table>`
    : '<p class="muted">Niciun stoc. Adaugă produse/gestiuni și înregistrează recepții.</p>';
  $$('#stocksList .pdel').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi produsul? (permis doar dacă nu are nicio mișcare)')) return;
    try { await api('/api/products/' + b.dataset.id, { method: 'DELETE' }); loadStocks(); toast('Produs șters'); }
    catch (e) { toast(e.message || 'Nu se poate șterge', true); }
  }));
  $$('#stocksList .ptoggle').forEach((b) => b.addEventListener('click', async () => {
    const activ = b.dataset.activ === '0'; // reactivare dacă era inactiv
    await api('/api/products/' + b.dataset.id + '/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activ }) });
    loadStocks(); toast(activ ? 'Produs reactivat' : 'Produs dezactivat');
  }));
  // mișcări (cu filtre)
  STOCK_MOVS = movs;
  $('#mvfGest').innerHTML = '<option value="">Toate gestiunile</option>' + gestiuni.map((g) => `<option value="${H(g.cod)}">${H(g.cod)} — ${H(g.denumire)}</option>`).join('');
  renderStockMovements();
  // verificarea stocului preluat vs. soldurile inițiale (daca exista o preluare)
  try { renderInitialCheck((await api('/api/stocks/initial-check')).totaluri); } catch (e) { /* ignora */ }
  // procese-verbale de inventariere
  const invs = await api('/api/inventories');
  $('#inventoriesList').innerHTML = invs.length
    ? `<table><thead><tr><th>Data</th><th>Gestiune</th><th>Operator</th><th class="num">Plusuri</th><th class="num">Minusuri</th><th class="num">Imputat</th><th>Stare</th><th></th></tr></thead><tbody>${
      invs.map((iv) => `<tr${iv.status === 'stornat' ? ' class="muted"' : ''}><td>${iv.data}</td><td>${iv.gestiuneCod}</td><td>${iv.operator || '—'}</td>
        <td class="num">${iv.nrPlus} (${fmt(iv.totalPlus)})</td><td class="num">${iv.nrMinus} (${fmt(iv.totalMinus)})</td><td class="num">${fmt(iv.totalImputat)}</td>
        <td>${iv.status === 'stornat' ? '<span class="pill">stornat ' + (iv.stornoData || '') + '</span>' : 'activ'}</td>
        <td><a class="linkbtn" href="/pdf/inventory-pv/${iv.id}" target="_blank">proces-verbal</a>${iv.status === 'stornat' ? '' : ` · <button class="linkbtn ivstorno" data-id="${iv.id}">stornează</button>`}</td></tr>`).join('')}</tbody></table>`
    : '';
  $$('#inventoriesList .ivstorno').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Stornezi acest inventar? Se reversează notele contabile și se șterg mișcările de reglare (stocul revine la starea de dinainte).')) return;
    try { const r = await api('/api/inventories/' + b.dataset.id + '/storno', { method: 'POST' }); toast('Inventar stornat (' + r.stornoEntries + ' note reversate)'); loadStocks(); }
    catch (err) { toast(err.message, true); }
  }));
  loadDocSeries();
  $('#docRegPdf').href = '/pdf/doc-register';
  const reg = await api('/api/doc-register');
  $('#docRegisterList').innerHTML = reg.length
    ? `<table><thead><tr><th>Tip</th><th>Serie/Nr</th><th>Data</th><th>Gestiune</th><th>Referință</th><th class="num">Valoare</th><th>Operator</th></tr></thead><tbody>${
      reg.map((r) => `<tr><td>${H(r.tip)}</td><td class="acc">${H(r.serieNr)}</td><td>${H(r.data)}</td><td>${H(r.gestiune)}</td><td>${H(r.document)}</td><td class="num">${fmt(r.valoare)}</td><td>${r.operator ? H(r.operator) : '—'}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Niciun document emis încă (numerele se atribuie la prima tipărire a unui NIR/bon/aviz).</p>';
}
onPeriodChange('stoc', loadStocks);
$('#stocGestFilter').addEventListener('change', loadStocks);
async function loadDocSeries() {
  let s; try { s = await api('/api/doc-series'); } catch (e) { return; }
  const f = $('#docSeriesForm');
  ['NIR', 'BC', 'AVIZ', 'CH'].forEach((t) => { if (s[t]) { f[t + '_serie'].value = s[t].serie; f[t + '_next'].value = s[t].next; } });
}
$('#docSeriesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { NIR: { serie: f.NIR_serie.value, next: f.NIR_next.value }, BC: { serie: f.BC_serie.value, next: f.BC_next.value }, AVIZ: { serie: f.AVIZ_serie.value, next: f.AVIZ_next.value }, CH: { serie: f.CH_serie.value, next: f.CH_next.value } };
  await api('/api/doc-series', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  toast('Serii salvate'); loadDocSeries();
});
$('#gestiuneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try { await api('/api/gestiuni', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cod: f.cod.value, denumire: f.denumire.value, gestionar: f.gestionar.value, cont: f.cont.value }) }); toast('Gestiune salvată'); f.reset(); f.cont.value = '371'; loadStocks(); }
  catch (err) { toast(err.message, true); }
});
$('#productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { cod: f.cod.value, denumire: f.denumire.value, um: f.um.value, cont: f.cont.value, grupa: f.grupa.value, codNC: f.codNC.value };
  try { await api('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast('Produs salvat'); f.reset(); f.um.value = 'buc'; f.cont.value = '371'; loadStocks(); }
  catch (err) { toast(err.message, true); }
});
$('#prodCsvFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) { try { $('#prodCsvIn').value = await fileToCsv(f); } catch (err) { toast(err.message, true); } } });
$('#prodImportBtn').addEventListener('click', async () => {
  const csv = $('#prodCsvIn').value.trim(); if (!csv) return toast('Lipiește un CSV', true);
  try { const r = await api('/api/products/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) }); toast(r.importati + ' produse importate'); $('#prodCsvIn').value = ''; loadStocks(); }
  catch (err) { toast(err.message, true); }
});
// Preluare stoc inițial (cantitativ-valoric) din CSV/XLS/XLSX/DBF, la data preluării firmei
function renderInitialCheck(tot) {
  const box = $('#initStocCheck'); if (!box) return;
  box.innerHTML = (tot || []).length
    ? `<table><thead><tr><th>Cont stoc</th><th class="num">Stoc inițial preluat</th><th class="num">Sold inițial cont</th><th class="num">Diferență</th></tr></thead><tbody>${
      tot.map((t) => `<tr><td class="acc">${t.cont}</td><td class="num">${fmt(t.stocInitial)}</td><td class="num">${fmt(t.soldInitial)}</td><td class="num"${Math.abs(t.diferenta) >= 0.01 ? ' data-u="u33"' : ''}>${fmt(t.diferenta)}</td></tr>`).join('')}</tbody></table>
      <p class="muted" data-u="u18">Verificare cantitativ-valoric vs. contabilitate: <b>Diferență ≠ 0</b> înseamnă că valoarea stocului preluat nu bate cu soldul inițial sintetic al contului — corectează soldurile inițiale sau cantitățile/valorile preluate.</p>`
    : '';
}
$('#initStocFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) { try { $('#initStocCsv').value = await fileToCsv(f); } catch (err) { toast(err.message, true); } } });
$('#initStocBtn').addEventListener('click', async () => {
  const csv = $('#initStocCsv').value.trim(); if (!csv) return toast('Lipiește sau încarcă stocul (CSV/XLS/DBF)', true);
  const data = $('#initStocData').value; if (!data) return toast('Alege data preluării', true);
  try {
    const r = await api('/api/stocks/import-initial', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv, data }) });
    const s = $('#initStocStatus'); s.className = 'status ' + (r.erori.length ? 'err' : 'ok');
    s.textContent = r.importate + ' poziții preluate'
      + (r.produseNoi ? ', ' + r.produseNoi + ' produse noi' : '') + (r.gestiuniNoi ? ', ' + r.gestiuniNoi + ' gestiuni noi' : '')
      + (r.erori.length ? ' — ' + r.erori.length + ' rânduri cu probleme: ' + r.erori.slice(0, 3).join('; ') + (r.erori.length > 3 ? '…' : '') : '.');
    renderInitialCheck(r.totaluri);
    $('#initStocCsv').value = '';
    loadStocks();
  } catch (err) { toast(err.message, true); }
});
// transfer => arată gestiunea destinație, ascunde prețul
$('#movementForm').tip.addEventListener('change', (e) => {
  const isTransfer = e.target.value === 'transfer';
  const isReceptie = e.target.value === 'receptie';
  $('#gestDestRow').classList.toggle('hidden', !isTransfer);
  $('#pretRow').classList.toggle('hidden', isTransfer);
  $('#furnizorRow').classList.toggle('hidden', !isReceptie);
  $('#gestSrcRow').firstChild.textContent = isTransfer ? 'Gestiune sursă ' : 'Gestiune ';
});
$('#movementForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { productId: f.productId.value, tip: f.tip.value, gestiuneId: f.gestiuneId.value, gestiuneDestId: f.gestiuneDestId.value, data: f.data.value, cantitate: f.cantitate.value, pretUnitar: f.pretUnitar.value, furnizor: f.furnizor.value, document: f.document.value };
  try { await api('/api/stock-movements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast('Mișcare înregistrată'); f.cantitate.value = ''; f.pretUnitar.value = ''; f.furnizor.value = ''; f.document.value = ''; loadStocks(); }
  catch (err) { toast(err.message, true); }
});
// ── Producție ──
let PROD_OPTS = { products: [], gestiuni: [] };
function prodMatRow() {
  const div = document.createElement('div');
  div.className = 'row'; div.style.cssText = 'gap:6px;margin-top:4px;align-items:center';
  div.innerHTML = `<select class="pm-prod" data-u="u52">${PROD_OPTS.products.map((p) => `<option value="${p.id}">${H(p.cod)} — ${H(p.denumire)}</option>`).join('')}</select>
    <select class="pm-gest" data-u="u46">${PROD_OPTS.gestiuni.map((g) => `<option value="${g.id}">${g.cod}</option>`).join('')}</select>
    <input class="pm-qty" type="number" step="0.001" placeholder="cantitate" data-u="u46">
    <button type="button" class="del pm-del" title="Elimină">✕</button>`;
  div.querySelector('.pm-del').addEventListener('click', () => div.remove());
  return div;
}
function fillProduction(products, gestiuni) {
  PROD_OPTS = { products: products || [], gestiuni: gestiuni || [] };
  const f = $('#prodForm'); if (!f) return;
  f.productId.innerHTML = PROD_OPTS.products.map((p) => `<option value="${p.id}">${H(p.cod)} — ${H(p.denumire)}</option>`).join('') || '<option value="">(niciun produs)</option>';
  f.gestiuneId.innerHTML = PROD_OPTS.gestiuni.map((g) => `<option value="${g.id}">${H(g.cod)} — ${H(g.denumire)}</option>`).join('') || '<option value="">(nicio gestiune)</option>';
  if (!f.data.value) f.data.value = new Date().toISOString().slice(0, 10);
  if (!$('#prodMaterials').children.length) $('#prodMaterials').appendChild(prodMatRow());
  renderProductionReport();
}
async function renderProductionReport() {
  const box = $('#prodReport'); if (!box) return;
  try {
    const r = await api('/api/production-report?period=' + workMonth());
    box.innerHTML = (r.rows || []).length
      ? `<table><thead><tr><th>Data</th><th>Cod</th><th>Produs</th><th class="num">Cant.</th><th class="num">Cost unit.</th><th class="num">Valoare</th></tr></thead><tbody>${
        r.rows.map((x) => `<tr><td>${x.data}</td><td class="acc">${H(x.cod)}</td><td>${H(x.denumire)}</td><td class="num">${fmt(x.cantitate)}</td><td class="num">${fmt(x.cost)}</td><td class="num">${fmt(x.valoare)}</td></tr>`).join('')
      }<tr class="total"><td colspan="3">TOTAL</td><td class="num">${fmt(r.totalCantitate)}</td><td></td><td class="num">${fmt(r.totalValoare)}</td></tr></tbody></table>`
      : '<p class="muted">Nicio producție înregistrată în luna de lucru.</p>';
  } catch (e) { /* ignora */ }
}
$('#prodAddMat') && $('#prodAddMat').addEventListener('click', () => $('#prodMaterials').appendChild(prodMatRow()));
$('#prodForm') && $('#prodForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const materiale = $$('#prodMaterials .row').map((row) => ({
    productId: row.querySelector('.pm-prod').value, gestiuneId: row.querySelector('.pm-gest').value, cantitate: Number(row.querySelector('.pm-qty').value) || 0,
  })).filter((m) => m.productId && m.cantitate > 0);
  const body = { productId: f.productId.value, gestiuneId: f.gestiuneId.value, cantitate: f.cantitate.value, costUnitar: f.costUnitar.value, data: f.data.value, document: f.document.value, materiale };
  try {
    const r = await api('/api/production', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('#prodStatus').className = 'status ok';
    $('#prodStatus').textContent = 'Producție înregistrată: cost materiale ' + fmt(r.costMateriale) + ', valoare obținută ' + fmt(r.valoareObtinuta) + ' lei.' + (r.warns.length ? ' ' + r.warns.join(' ') : '');
    f.cantitate.value = ''; f.costUnitar.value = ''; f.document.value = ''; $('#prodMaterials').innerHTML = '';
    loadStocks(); loadEntries();
  } catch (err) { $('#prodStatus').className = 'status err'; $('#prodStatus').textContent = err.message; }
});
// ── Rețete / BOM ──
function recipeMatRow(mat) {
  const div = document.createElement('div');
  div.className = 'row'; div.style.cssText = 'gap:6px;margin-top:4px;align-items:center';
  div.innerHTML = `<select class="rm-prod" data-u="u52">${PROD_OPTS.products.map((p) => `<option value="${p.id}">${H(p.cod)} — ${H(p.denumire)}</option>`).join('')}</select>
    <select class="rm-gest" data-u="u46">${PROD_OPTS.gestiuni.map((g) => `<option value="${g.id}">${H(g.cod)}</option>`).join('')}</select>
    <input class="rm-qty" type="number" step="0.001" placeholder="cantitate" data-u="u46">
    <button type="button" class="del rm-del" title="Elimină">✕</button>`;
  if (mat) {
    div.querySelector('.rm-prod').value = mat.productId;
    if (mat.gestiuneId) div.querySelector('.rm-gest').value = mat.gestiuneId;
    div.querySelector('.rm-qty').value = mat.cantitate;
  }
  div.querySelector('.rm-del').addEventListener('click', () => div.remove());
  return div;
}
function recipeResetForm() {
  const f = $('#recipeForm'); if (!f) return;
  f.reset(); f.id.value = ''; f.cantitateBaza.value = '1';
  $('#recipeMaterials').innerHTML = ''; $('#recipeMaterials').appendChild(recipeMatRow());
  $('#recipeStatus').textContent = '';
}
function fillRecipes(products, gestiuni) {
  const f = $('#recipeForm'); if (!f) return;
  f.productId.innerHTML = (products || []).map((p) => `<option value="${p.id}">${H(p.cod)} — ${H(p.denumire)}</option>`).join('') || '<option value="">(niciun produs)</option>';
  f.gestiuneId.innerHTML = (gestiuni || []).map((g) => `<option value="${g.id}">${H(g.cod)} — ${H(g.denumire)}</option>`).join('') || '<option value="">(nicio gestiune)</option>';
  if (!$('#recipeMaterials').children.length) $('#recipeMaterials').appendChild(recipeMatRow());
  renderRecipes(products);
}
async function renderRecipes(products) {
  const box = $('#recipeList'); if (!box) return;
  const pName = (id) => { const p = (products || PROD_OPTS.products).find((x) => x.id === id); return p ? p.cod + ' — ' + p.denumire : id; };
  let list; try { list = await api('/api/recipes'); } catch (e) { return; }
  if (!list.length) { box.innerHTML = '<p class="muted">Nicio rețetă salvată.</p>'; return; }
  box.innerHTML = `<table><thead><tr><th>Rețetă</th><th>Produs finit</th><th class="num">Cant. bază</th><th class="num">Materiale</th><th>Acțiuni</th></tr></thead><tbody>${
    list.map((r) => `<tr data-id="${r.id}"><td><b>${r.nume}</b></td><td>${pName(r.productId)}</td><td class="num">${fmt(r.cantitateBaza)}</td><td class="num">${(r.materiale || []).length}</td>
      <td class="row" data-u="u189">
        <input class="rc-qty" type="number" step="0.001" placeholder="cant." data-u="u190" title="Cantitate de produs">
        <button class="btn small primary rc-produce" title="Produce această cantitate">▶ Produce</button>
        <button class="btn small ghost rc-edit">Editează</button>
        <button class="del rc-del" title="Șterge">✕</button>
      </td></tr>`).join('')}</tbody></table>`;
  box._recipes = list;
  $$('#recipeList .rc-produce').forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr'); const id = tr.dataset.id; const qty = Number(tr.querySelector('.rc-qty').value) || 0;
    if (!(qty > 0)) return toast('Indică o cantitate', true);
    b.disabled = true;
    try {
      const r = await api('/api/recipes/' + id + '/produce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cantitate: qty, data: $('#prodForm') ? $('#prodForm').data.value : undefined }) });
      $('#recipeStatus').className = 'status ok';
      $('#recipeStatus').textContent = 'Producție din rețetă: cost materiale ' + fmt(r.costMateriale) + ', valoare obținută ' + fmt(r.valoareObtinuta) + ' lei.' + (r.warns.length ? ' ' + r.warns.join(' ') : '');
      loadStocks(); loadEntries();
    } catch (err) { $('#recipeStatus').className = 'status err'; $('#recipeStatus').textContent = err.message; b.disabled = false; }
  }));
  $$('#recipeList .rc-edit').forEach((b) => b.addEventListener('click', () => {
    const r = box._recipes.find((x) => x.id === b.closest('tr').dataset.id); if (!r) return;
    const f = $('#recipeForm');
    f.id.value = r.id; f.nume.value = r.nume; f.productId.value = r.productId; if (r.gestiuneId) f.gestiuneId.value = r.gestiuneId;
    f.cantitateBaza.value = r.cantitateBaza; f.costUnitar.value = r.costUnitar || '';
    $('#recipeMaterials').innerHTML = '';
    (r.materiale || []).forEach((m) => $('#recipeMaterials').appendChild(recipeMatRow(m)));
    if (!(r.materiale || []).length) $('#recipeMaterials').appendChild(recipeMatRow());
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  $$('#recipeList .rc-del').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi rețeta?')) return;
    try { await api('/api/recipes/' + b.closest('tr').dataset.id, { method: 'DELETE' }); toast('Rețetă ștearsă'); renderRecipes(products); }
    catch (err) { toast(err.message, true); }
  }));
}
$('#recipeAddMat') && $('#recipeAddMat').addEventListener('click', () => $('#recipeMaterials').appendChild(recipeMatRow()));
$('#recipeReset') && $('#recipeReset').addEventListener('click', recipeResetForm);
$('#recipeForm') && $('#recipeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const materiale = $$('#recipeMaterials .row').map((row) => ({
    productId: row.querySelector('.rm-prod').value, gestiuneId: row.querySelector('.rm-gest').value, cantitate: Number(row.querySelector('.rm-qty').value) || 0,
  })).filter((m) => m.productId && m.cantitate > 0);
  const body = { id: f.id.value || undefined, nume: f.nume.value, productId: f.productId.value, gestiuneId: f.gestiuneId.value, cantitateBaza: f.cantitateBaza.value, costUnitar: f.costUnitar.value, materiale };
  try {
    await api('/api/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('#recipeStatus').className = 'status ok'; $('#recipeStatus').textContent = 'Rețetă salvată.';
    recipeResetForm(); renderRecipes();
  } catch (err) { $('#recipeStatus').className = 'status err'; $('#recipeStatus').textContent = err.message; }
});
// ── Inventariere ──
$('#invGest').addEventListener('change', () => { $('#invPdf').href = '/pdf/inventory?asOf=' + stocAsOf() + '&gestiune=' + $('#invGest').value; });
$('#invLoad').addEventListener('click', async () => {
  const gid = $('#invGest').value;
  if (!gid) return toast('Adaugă o gestiune întâi', true);
  const list = await api('/api/inventory?gestiune=' + gid + '&asOf=' + stocAsOf());
  if (!list.length) { $('#inventoryArea').innerHTML = '<p class="muted">Niciun produs în nomenclator.</p>'; return; }
  $('#inventoryArea').innerHTML = `<table><thead><tr><th>Cod</th><th>Denumire</th><th class="num">Scriptic</th><th class="num">CMP</th><th class="num">Faptic</th><th>Imputare</th></tr></thead><tbody>${
    list.map((l) => `<tr data-pid="${l.product.id}"><td class="acc">${H(l.product.cod)}</td><td>${H(l.product.denumire)}</td>
      <td class="num scr">${fmt(l.scripticQty)} ${l.product.um || ''}</td><td class="num">${fmt(l.cmp)}</td>
      <td class="num"><input class="inv-fapt" type="number" step="0.001" value="${l.scripticQty}" data-u="u178"></td>
      <td><input class="inv-imp" type="checkbox" title="Impută lipsa gestionarului"></td></tr>`).join('')}</tbody></table>
    <div class="row" data-u="u8"><input id="invData" type="date" value="${stocAsOf()}-28" data-u="u120"> <button id="invPost" class="btn primary">Înregistrează diferențele</button></div>`;
  $('#invPost').addEventListener('click', async () => {
    const lines = $$('#inventoryArea tbody tr').map((tr) => ({ productId: tr.dataset.pid, faptic: tr.querySelector('.inv-fapt').value, imputa: tr.querySelector('.inv-imp').checked }));
    try {
      const r = await api('/api/inventory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gestiuneId: gid, data: $('#invData').value, lines }) });
      const res = r.result;
      toast(`Inventar înregistrat: ${res.plusuri.length} plus, ${res.minusuri.length} minus${res.imputari.length ? ', ' + res.imputari.length + ' imputări' : ''}`);
      $('#inventoryArea').innerHTML = ''; loadStocks();
    } catch (err) { toast(err.message, true); }
  });
});


export { loadStocks };
