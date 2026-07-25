'use strict';

// Fluxul documentelor: upload + scanare (punte/camera), wizardul de tipuri, facturile recurente, SPV inbox + import e-Factura si formularul UNIC de inregistrare (mutat intre Documente/Emite).
// Extras din app.js (faza 2); apelurile inapoi spre app.js vin prin setDeps (fara cicluri).
import { $$, $, H, fmt, accName, toast, api, META, setMeta, applyFiscalDefaults } from './core.js';
import { workMonth, fillPeriods } from './periods.js';
import { loadEntries } from './entries.js';

const D = { goTab: null };
function setDocflowDeps(d) { Object.assign(D, d); }

let CURRENT = null; // { documentId, fields, suggestedType }
function fillTipSelect() {
  const sel = $('#tipSelect');
  const groups = {};
  META.types.forEach((t) => { (groups[t.grup] = groups[t.grup] || []).push(t); });
  sel.innerHTML = Object.keys(groups).map((g) =>
    `<optgroup label="${g}">${groups[g].map((t) => `<option value="${t.id}">${H(t.nume)}</option>`).join('')}</optgroup>`
  ).join('');
}
const drop = $('#drop'), fileInput = $('#file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); });
let scanStream = null;
async function startScanStream(deviceId) {
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  const get = (v) => navigator.mediaDevices.getUserMedia({ audio: false, video: v });
  try {
    // preferă camera din spate (telefon), dar fără a o impune
    scanStream = await get(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } });
  } catch (e) {
    scanStream = await get(true); // fallback: orice cameră disponibilă (ex. webcam PC)
  }
  $('#scanVideo').srcObject = scanStream;
}
async function openScan() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Camera nu e suportată de acest browser.', true);
  try {
    await startScanStream();
    // listă camere (după ce avem permisiune, ca să apară etichetele)
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const sel = $('#scanCam');
      sel.innerHTML = devs.map((d, i) => `<option value="${d.deviceId}">${d.label || ('Cameră ' + (i + 1))}</option>`).join('');
      sel.style.display = devs.length > 1 ? '' : 'none';
    } catch (e) { /* ignora */ }
    $('#scanModal').classList.remove('hidden');
  } catch (e) {
    toast('Nu pot accesa camera: ' + (e.message || e) + '. Permite accesul la cameră în browser.', true);
  }
}
function closeScan() {
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  const v = $('#scanVideo'); if (v) v.srcObject = null;
  $('#scanModal').classList.add('hidden');
}
async function scanFromBridge() {
  const st = $('#uploadStatus'); st.className = 'status'; st.textContent = 'Se scanează… urmează fereastra de scanare (Windows / NAPS2). Lasă puntea pornită.';
  let res;
  try {
    res = await fetch('http://127.0.0.1:8765/scan');
  } catch (e) {
    // eroare de rețea = puntea nu rulează / blocată
    st.className = 'status err';
    st.textContent = 'Nu găsesc puntea de scanare locală. Pornește „Start-Contab-Scanner.bat" pe acest PC, apoi reîncearcă.';
    const d = $('#scanSetup'); if (d) d.open = true;
    toast('Puntea de scanare nu rulează — vezi „Configurează scanerul local".', true);
    return;
  }
  if (!res.ok) {
    // puntea răspunde, dar scanarea a eșuat — arătăm mesajul real
    const msg = (await res.text().catch(() => '')) || ('cod ' + res.status);
    console.error('[Contabo] Scanare eșuată (de la punte):', msg);
    st.className = 'status err';
    st.textContent = 'Scanarea a eșuat: ' + msg + '  (vezi și fereastra punții). Sfat: instalează NAPS2 pentru fiabilitate.';
    toast('Scanare eșuată: ' + msg, true);
    return;
  }
  const blob = await res.blob();
  const pdf = blob.type === 'application/pdf';
  const file = new File([blob], 'scan-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + (pdf ? '.pdf' : '.jpg'), { type: blob.type || 'image/jpeg' });
  uploadFile(file);
}
$('#scannerBtn') && $('#scannerBtn').addEventListener('click', scanFromBridge);
if ($('#scanBtn')) {
  $('#scanBtn').addEventListener('click', openScan);
  $('#scanClose').addEventListener('click', closeScan);
  $('#scanModal').addEventListener('click', (e) => { if (e.target.id === 'scanModal') closeScan(); });
  $('#scanCam').addEventListener('change', (e) => startScanStream(e.target.value).catch(() => {}));
  $('#scanShot').addEventListener('click', () => {
    const v = $('#scanVideo');
    if (!v.videoWidth) return toast('Camera încă se inițializează…', true);
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
      if (!blob) return toast('Nu s-a putut captura imaginea.', true);
      const file = new File([blob], 'scan-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.jpg', { type: 'image/jpeg' });
      closeScan();
      uploadFile(file);
    }, 'image/jpeg', 0.92);
  });
}
async function uploadFile(file) {
  const st = $('#uploadStatus'); st.className = 'status'; st.textContent = 'Se citește „' + file.name + '”…';
  const fd = new FormData(); fd.append('file', file);
  try {
    const res = await api('/api/upload', { method: 'POST', body: fd });
    st.className = 'status ok';
    const via = res.source === 'ai'
      ? '🤖 AI' + (res.incredere != null ? ' (încredere ' + res.incredere + '%)' : '')
      : '⚙️ reguli locale';
    st.innerHTML = 'Extras din „' + res.fileName + '” prin ' + via + '. CUI: ' + ((res.cuis || []).join(', ') || '—')
      + (res.motiv ? '<br><span class="muted">' + H(res.motiv) + '</span>' : '')
      + (res.warning ? '<br><span data-u="u13">' + H(res.warning) + '</span>' : '')
      + ((res.checkWarnings || []).length
        ? '<br><span data-u="u13">⚠️ Verifică: ' + res.checkWarnings.map(H).join('<br>⚠️ ') + '</span>' : '');
    CURRENT = { documentId: res.documentId, fields: res.fields, suggestedType: res.suggestedType };
    openForm(res.suggestedType, res.fields);
  } catch (e) { st.className = 'status err'; st.textContent = e.message; }
}
$('#manualBtn').addEventListener('click', () => { CURRENT = { documentId: null, fields: {}, suggestedType: 'nota_contabila' }; openForm('nota_contabila', { data: new Date().toISOString().slice(0, 10) }); });
const WIZ = [
  { ic: '🛒', label: 'Am cumpărat ceva', desc: 'O factură primită de la furnizor', kids: [
    { ic: '📦', label: 'Marfă (pentru revânzare)', tip: 'factura_cumparare_marfuri' },
    { ic: '🧱', label: 'Materiale / materii prime', tip: 'factura_cumparare_materii' },
    { ic: '🛠️', label: 'Servicii (chirie, telecom, onorarii)', tip: 'factura_servicii_primita' },
    { ic: '💡', label: 'Utilități (curent, apă, gaz)', tip: 'factura_utilitati' },
    { ic: '⛽', label: 'Combustibil', tip: 'factura_combustibil' },
    { ic: '🖥️', label: 'Echipament / mijloc fix', tip: 'factura_imobilizare' },
  ] },
  { ic: '💰', label: 'Am vândut / emit factură', desc: 'Factură către un client', kids: [
    { ic: '📦', label: 'Marfă', tip: 'factura_vanzare_marfuri' },
    { ic: '🏭', label: 'Produse (fabricate de mine)', tip: 'factura_vanzare_produse' },
    { ic: '🛠️', label: 'Servicii', tip: 'factura_vanzare_servicii' },
    { ic: '🧾', label: 'Bon fiscal (numerar, amănunt)', tip: 'bon_fiscal_z' },
  ] },
  { ic: '🏦', label: 'Bani (încasări / plăți)', desc: 'Mișcări prin bancă sau casă', kids: [
    { ic: '⬇️', label: 'Am încasat de la un client', tip: 'incasare_client' },
    { ic: '⬆️', label: 'Am plătit un furnizor', tip: 'plata_furnizor' },
    { ic: '🏧', label: 'Depunere numerar la bancă', tip: 'depunere_numerar' },
    { ic: '💵', label: 'Ridicare numerar din bancă', tip: 'ridicare_numerar' },
    { ic: '🏦', label: 'Comision bancar', tip: 'comision_bancar' },
  ] },
  { ic: '👥', label: 'Salarii', desc: 'Calcul și plata salariilor', kids: [
    { ic: '🧮', label: 'Calcul salarii (stat de plată)', tip: 'stat_plata' },
    { ic: '💸', label: 'Plata salariilor', tip: 'plata_salarii' },
  ] },
  { ic: '⋯', label: 'Altceva', desc: 'Notă liberă sau toate tipurile', kids: [
    { ic: '📋', label: 'Notă contabilă liberă', tip: 'nota_contabila' },
    { ic: '🔎', label: 'Alege din toate tipurile…', tip: '__all__' },
  ] },
];
let opwCat = null;
function renderWizard() {
  const opened = !!opwCat;
  $('#opwBack').classList.toggle('hidden', !opened);
  $('#opwTitle').textContent = opened ? opwCat.label : 'Ce vrei să înregistrezi?';
  $('#opwHint').textContent = opened ? 'Alege mai exact:' : 'Alege în cuvinte simple — aplicația alege singură tipul contabil potrivit.';
  const grid = $('#opwGrid');
  const items = opened ? opwCat.kids : WIZ;
  grid.innerHTML = items.map((x, i) => `<button type="button" class="opw-card" data-i="${i}">
    <span class="opw-ic">${x.ic}</span><span class="opw-t">${x.label}</span>${x.desc ? `<span class="opw-d">${x.desc}</span>` : ''}</button>`).join('');
  $$('#opwGrid .opw-card').forEach((b) => b.addEventListener('click', () => {
    const x = items[+b.dataset.i];
    if (x.kids) { opwCat = x; renderWizard(); } else pickWizardType(x.tip);
  }));
}
function openWizard() { opwCat = null; renderWizard(); $('#opWizard').classList.remove('hidden'); }
function closeWizard() { $('#opWizard').classList.add('hidden'); }
const IESIRE_TIPS = /^(factura_vanzare|factura_storno_vanzare|bon_fiscal_z|factura_simplificata|aviz_livrare|facturare_aviz|livrare_intracomunitara)/;
function pickWizardType(tip) {
  closeWizard();
  const real = tip === '__all__' ? 'nota_contabila' : tip;
  const dest = IESIRE_TIPS.test(real) ? 'emite' : 'documente';
  D.goTab(dest);
  CURRENT = { documentId: null, fields: {}, suggestedType: real };
  openForm(real, { data: new Date().toISOString().slice(0, 10) }, dest);
  setTimeout(() => { const el = $('#entryForm'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (tip === '__all__') { const t = $('#tipSelect'); if (t) t.focus(); } }, 80);
}
$('#qaWizard') && $('#qaWizard').addEventListener('click', openWizard);
$('#opwBack') && $('#opwBack').addEventListener('click', () => { opwCat = null; renderWizard(); });
$('#opwClose') && $('#opwClose').addEventListener('click', closeWizard);
$('#opWizard') && $('#opWizard').addEventListener('click', (e) => { if (e.target.id === 'opWizard') closeWizard(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#opWizard').classList.contains('hidden')) closeWizard(); });
$$('.emit').forEach((btn) => btn.addEventListener('click', () => {
  const tip = btn.dataset.tip;
  CURRENT = { documentId: null, fields: {}, suggestedType: tip };
  openForm(tip, { data: new Date().toISOString().slice(0, 10) }, 'emite');
  setTimeout(() => $('#entryForm').scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
}));
// Linkuri catre registrele/situatiile generate
$$('.linklist a[data-go]').forEach((a) => { a.style.cursor = 'pointer'; a.addEventListener('click', () => D.goTab(a.dataset.go)); });
async function renderRecurring() {
  const sel = $('#recTip');
  if (sel && !sel.options.length) sel.innerHTML = (META.types || []).map((t) => `<option value="${t.id}">${H(t.nume)}</option>`).join('');
  if ($('#recPeriod') && !$('#recPeriod').value) $('#recPeriod').value = workMonth();
  let list;
  try { list = await api('/api/recurring'); } catch (e) { return; }
  const box = $('#recList');
  if (!list.length) { box.innerHTML = '<p class="muted">Niciun șablon recurent definit încă.</p>'; return; }
  const tname = (id) => ((META.types || []).find((t) => t.id === id) || {}).nume || id;
  box.innerHTML = `<table><thead><tr><th>Document</th><th>Partener</th><th class="num">Bază</th><th>Frecvență</th><th>Din</th><th>Ultima</th><th></th></tr></thead><tbody>${
    list.map((t) => `<tr${t.activ ? '' : ' data-u="u21"'}><td>${H(tname(t.tip))}</td><td>${H(t.partener || '—')}</td>
      <td class="num">${fmt((t.fields || {}).baza || 0)}</td><td>${t.frecventa}</td><td>${t.startDate || ''}</td><td>${t.lastGenerated || '—'}</td>
      <td><button class="linkbtn rectog" data-id="${t.id}" data-activ="${t.activ ? 1 : 0}">${t.activ ? 'dezactivează' : 'activează'}</button> · <button class="del recdel" data-id="${t.id}">✕</button></td></tr>`).join('')}</tbody></table>`;
  $$('#recList .recdel').forEach((b) => b.addEventListener('click', async () => { if (confirm('Ștergi șablonul recurent?')) { await api('/api/recurring/' + b.dataset.id, { method: 'DELETE' }); renderRecurring(); } }));
  $$('#recList .rectog').forEach((b) => b.addEventListener('click', async () => {
    const t = list.find((x) => x.id === b.dataset.id); if (!t) return;
    await api('/api/recurring', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, t, { activ: !t.activ })) });
    renderRecurring();
  }));
}
$('#recForm') && $('#recForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const baza = Number(f.baza.value) || 0; const cota = Number(f.cota.value) || 0;
  const body = {
    tip: f.tip.value, partener: f.partener.value, cuiPartener: f.cuiPartener.value, document: f.document.value,
    fields: { baza, cota, tva: Math.round(baza * cota) / 100 },
    frecventa: f.frecventa.value, ziua: f.ziua.value, startDate: f.startDate.value || workMonth(),
  };
  try { await api('/api/recurring', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); f.reset(); applyFiscalDefaults(f); renderRecurring(); toast('Șablon recurent salvat'); }
  catch (err) { toast(err.message, true); }
});
$('#recGenBtn') && $('#recGenBtn').addEventListener('click', async () => {
  const period = $('#recPeriod').value; if (!period) return toast('Alege luna', true);
  $('#recGenStatus').textContent = 'Se generează…';
  try {
    const r = await api('/api/recurring/generate?period=' + period, { method: 'POST' });
    $('#recGenStatus').textContent = r.created + ' factură(i) generate' + (r.errors.length ? (', ' + r.errors.length + ' erori') : '') + '.';
    if (r.errors.length) toast(r.errors.join(' | '), true);
    else if (r.created) toast(r.created + ' facturi recurente generate pentru ' + period);
    else toast('Nimic de generat pentru ' + period + ' (deja generate sau niciun șablon scadent)');
    renderRecurring(); loadEntries();
  } catch (e) { $('#recGenStatus').textContent = ''; toast(e.message, true); }
});
$('#inboxRefresh').addEventListener('click', loadInbox);
async function loadInbox() {
  const box = $('#inboxList'); box.innerHTML = '<p class="muted">Se încarcă…</p>';
  try {
    const msgs = await api('/api/anaf/inbox?zile=60');
    if (!msgs.length) { box.innerHTML = '<p class="muted">Nicio factură primită în ultimele 60 de zile.</p>'; return; }
    box.innerHTML = `<table><thead><tr><th>Data</th><th>Emitent (CIF)</th><th>Detalii</th><th></th></tr></thead><tbody>${
      msgs.map((m) => `<tr><td>${m.data || ''}</td><td>${m.cif || ''}</td><td>${H((m.detalii || '').slice(0, 60))}</td>
        <td>${m.importat ? '<span class="pill">importată</span>' : `<button class="linkbtn spvimp" data-id="${m.id}">importă</button>`}</td></tr>`).join('')}</tbody></table>`;
    $$('#inboxList .spvimp').forEach((b) => b.addEventListener('click', () => importFromSpv(b.dataset.id)));
  } catch (e) { box.innerHTML = `<p class="status err">${e.message}</p>`; }
}
// Reconciliere facturi primite din SPV <-> jurnal cumparari (prinde ce vede ANAF dar nu e in contabilitate)
$('#einvReconBtn') && $('#einvReconBtn').addEventListener('click', loadEInvReconcile);
async function loadEInvReconcile() {
  const box = $('#einvReconResult'); box.innerHTML = '<p class="muted">Se reconciliază cu SPV…</p>';
  let r;
  try { r = await api('/api/efactura-reconciliere?zile=60'); }
  catch (e) { box.innerHTML = `<p class="status err">${H(e.message)}</p>`; return; }
  const badge = r.lipsaInJurnal ? `<span class="pill warn">${r.lipsaInJurnal} neînregistrate</span>` : '<span class="pill">0 neînregistrate</span>';
  let html = `<p class="muted">SPV: <b>${r.totalSpv}</b> facturi primite · Jurnal: <b>${r.totalJurnal}</b> cumpărări · ${badge} · ${r.faraSpvCount} fără corespondent SPV <span class="muted">(ultimele ${r.zile} zile)</span></p>`;
  if (r.neinregistrate.length) {
    html += `<div class="card"><h4>⚠️ Facturi în SPV, neînregistrate în jurnal</h4>
      <table><thead><tr><th>Data</th><th>Emitent (CIF)</th><th>Denumire</th></tr></thead><tbody>${
      r.neinregistrate.map((m) => `<tr><td>${H(m.data || '')}</td><td>${H(m.cif)}</td><td>${H(m.den || '')}</td></tr>`).join('')}</tbody></table>
      <p class="muted">Importă-le din lista „Facturi primite în SPV” de mai sus (buton „importă”).</p></div>`;
  } else if (r.totalSpv) {
    html += '<p class="status ok">Toate facturile din SPV au corespondent în jurnal. ✓</p>';
  }
  const disc = r.furnizori.filter((f) => f.lipsa > 0 || f.extra > 0);
  if (disc.length) {
    html += `<details class="pm-box"><summary>Detaliu pe furnizor (${disc.length} cu diferențe)</summary>
      <table><thead><tr><th>CIF</th><th>Denumire</th><th class="num">SPV</th><th class="num">Jurnal</th><th class="num">Lipsă</th><th class="num">Fără SPV</th></tr></thead><tbody>${
      disc.map((f) => `<tr><td>${H(f.cif)}</td><td>${H(f.den || '')}</td><td class="num">${f.spv}</td><td class="num">${f.jurnal}</td><td class="num">${f.lipsa || ''}</td><td class="num">${f.extra || ''}</td></tr>`).join('')}</tbody></table></details>`;
  }
  box.innerHTML = html;
}
async function importFromSpv(msgId) {
  const st = $('#uploadStatus'); st.className = 'status'; st.textContent = 'Se importă factura din SPV…';
  try {
    const res = await api('/api/anaf/import/' + msgId, { method: 'POST' });
    st.className = 'status ok'; st.textContent = 'Importat din SPV. Verifică și salvează.';
    CURRENT = { documentId: res.documentId, fields: res.fields, suggestedType: res.suggestedType, spvMsgId: res.msgId };
    openForm(res.suggestedType, res.fields);
  } catch (e) { st.className = 'status err'; st.textContent = e.message; }
}
$('#cancelEntry').addEventListener('click', closeForm);
$('#efImportFile') && $('#efImportFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { $('#efImportXml').value = await f.text(); $('#efParseBtn').click(); } catch (err) { toast(err.message, true); }
});
$('#efParseBtn') && $('#efParseBtn').addEventListener('click', async () => {
  const xml = $('#efImportXml').value.trim();
  if (!xml) return toast('Încarcă sau lipește un XML de e-Factura', true);
  const box = $('#efPreview'); box.innerHTML = '<p class="muted">Se citește…</p>';
  try {
    const r = await api('/api/efactura/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ xml }) });
    const inv = r.invoice;
    const liniiHtml = (inv.linii || []).length
      ? `<table data-u="u18"><thead><tr><th>Denumire</th><th class="num">Cant.</th><th class="num">Preț</th><th class="num">Valoare</th><th class="num">TVA%</th></tr></thead><tbody>${
        inv.linii.map((l) => `<tr><td>${H(l.nume)}</td><td class="num">${fmt(l.cantitate)}</td><td class="num">${fmt(l.pret)}</td><td class="num">${fmt(l.valoare)}</td><td class="num">${l.cota}</td></tr>`).join('')}</tbody></table>`
      : '';
    box.innerHTML = `<div class="card">
      <p data-u="u22">${inv.tip === 'creditnote' ? '↩️ <b>Notă de credit (storno)</b>' : '🧾 <b>Factură de cumpărare</b>'} ${inv.moneda !== 'RON' ? '<span class="status err">— monedă ' + inv.moneda + ' (neacceptat automat)</span>' : ''}</p>
      <table>
        <tr><td>Furnizor</td><td><b>${H(inv.furnizor.nume || '—')}</b> ${inv.furnizor.cui ? '(CUI ' + H(inv.furnizor.cui) + ')' : ''}</td></tr>
        <tr><td>Număr / Data</td><td>${inv.numar || '—'} · ${inv.data || '—'}</td></tr>
        <tr><td>Bază impozabilă</td><td class="num">${fmt(inv.baza)}</td></tr>
        <tr><td>TVA (${inv.cota}%)</td><td class="num">${fmt(inv.tva)}</td></tr>
        <tr class="total"><td>Total de plată</td><td class="num">${fmt(inv.total)}</td></tr>
      </table>${liniiHtml}
      <button id="efImportBtn" class="btn primary" data-u="u23" ${inv.moneda !== 'RON' ? 'disabled' : ''}>✓ Importă ca factură de cumpărare</button>
    </div>`;
    const ib = $('#efImportBtn');
    if (ib) ib.addEventListener('click', async () => {
      ib.disabled = true;
      try {
        const res = await api('/api/efactura/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ xml, cont: $('#efImportCont').value }) });
        toast('e-Factura importată: ' + (res.entry.document || '') + ' — ' + res.entry.partener);
        $('#efImportXml').value = ''; $('#efPreview').innerHTML = ''; $('#efImportFile').value = '';
        loadEntries();
      } catch (err) { toast(err.message, true); ib.disabled = false; }
    });
  } catch (e) { box.innerHTML = `<p class="status err">${e.message}</p>`; }
});
function mountForm(host) {
  const target = $(host === 'emite' ? '#formHostEmite' : '#formHostDoc');
  const f = $('#entryForm');
  if (target && f.parentElement !== target) target.appendChild(f);
}
function openForm(tipId, fields, host) {
  mountForm(host);
  $('#noDoc').classList.add('hidden');
  const ne = $('#noDocEmit'); if (ne) ne.classList.add('hidden');
  $('#entryForm').classList.remove('hidden');
  $('#tipSelect').value = tipId || 'nota_contabila';
  renderFields(fields || {});
}
function closeForm() {
  $('#entryForm').classList.add('hidden');
  $('#noDoc').classList.remove('hidden');
  const ne = $('#noDocEmit'); if (ne) ne.classList.remove('hidden');
  CURRENT = null;
}
$('#tipSelect').addEventListener('change', () => renderFields(collectFields()));
function accountOptions(val) {
  return META.accounts.map((a) => `<option value="${H(a.cod)}" ${a.cod === String(val) ? 'selected' : ''}>${H(a.cod)} — ${H(a.nume)}</option>`).join('');
}
function renderFields(values) {
  const tip = META.types.find((t) => t.id === $('#tipSelect').value);
  const box = $('#dynFields'); box.innerHTML = '';
  tip.fields.forEach((f) => {
    const v = values[f.name] != null ? values[f.name] : (f.default != null ? f.default : '');
    const id = 'fld_' + f.name;
    let input;
    if (f.type === 'select') input = `<select id="${id}">${f.options.map((o) => `<option value="${o.value}" ${o.value === String(v) ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`;
    else if (f.type === 'account') input = `<select id="${id}">${accountOptions(v)}</select>`;
    else if (f.type === 'date') input = `<input id="${id}" type="date" value="${v || ''}" />`;
    else if (f.type === 'number') input = `<input id="${id}" type="number" step="0.01" value="${v === '' ? '' : v}" />`;
    else if (f.type === 'items') input = `<div class="items-editor" id="${id}"><div class="items-rows"></div><button type="button" class="btn ghost small additem">＋ adaugă linie</button></div>`;
    else if (f.type === 'stoc') input = `<div class="stoc-editor" id="${id}"><div class="stoc-rows"></div><button type="button" class="btn ghost small addstoc">＋ produs din stoc</button><div class="muted" data-u="u25">Costul mărfii vândute (607=371) se calculează automat la <b>CMP</b>, la salvare.</div></div>`;
    else if (f.type === 'checkbox') input = `<input id="${id}" type="checkbox" ${v && v !== 'false' ? 'checked' : ''} data-u="u26" />`;
    else input = `<input id="${id}" type="text" value="${(v || '').toString().replace(/"/g, '&quot;')}" />`;
    const wide = (f.name === 'explicatie' || f.type === 'account' || f.type === 'select' || f.type === 'items' || f.type === 'stoc' || f.type === 'checkbox') ? ' full' : '';
    box.insertAdjacentHTML('beforeend', `<label class="${wide ? 'full' : ''}">${f.label}${input}</label>`);
  });
  // initializeaza editoarele de linii
  box.querySelectorAll('.items-editor').forEach((ed) => {
    const name = ed.id.replace('fld_', '');
    const init = Array.isArray(values[name]) ? values[name] : [];
    init.forEach((it) => addItemRow(ed, it));
    ed.querySelector('.additem').addEventListener('click', () => { addItemRow(ed, {}); updatePreview(); });
    ed.addEventListener('input', updatePreview);
    ed.addEventListener('click', (e) => { if (e.target.classList.contains('delitem')) { e.target.closest('.item-row').remove(); updatePreview(); } });
  });
  box.querySelectorAll('.stoc-editor').forEach((ed) => {
    const name = ed.id.replace('fld_', '');
    initStocEditor(ed, Array.isArray(values[name]) ? values[name] : []);
  });
  box.querySelectorAll('input,select').forEach((el) => el.addEventListener('input', updatePreview));
  updatePreview();
}
function addItemRow(ed, it) {
  const row = document.createElement('div');
  row.className = 'item-row';
  row.innerHTML = `<input class="it-nume" placeholder="Denumire" value="${H(it.nume)}">
    <input class="it-cant" type="number" step="0.001" placeholder="Cant." value="${it.cantitate != null ? it.cantitate : ''}">
    <input class="it-um" placeholder="UM" value="${it.um || 'buc'}">
    <input class="it-pret" type="number" step="0.01" placeholder="Preț" value="${it.pret != null ? it.pret : ''}">
    <input class="it-cota" type="number" placeholder="Cotă%" value="${it.cota != null ? it.cota : 21}">
    <button type="button" class="btn ghost small delitem">✕</button>`;
  ed.querySelector('.items-rows').appendChild(row);
}
function readItems(ed) {
  return [...ed.querySelectorAll('.item-row')].map((r) => ({
    nume: r.querySelector('.it-nume').value,
    cantitate: r.querySelector('.it-cant').value,
    um: r.querySelector('.it-um').value,
    pret: r.querySelector('.it-pret').value,
    cota: r.querySelector('.it-cota').value,
  })).filter((it) => it.nume && parseFloat(it.cantitate) > 0);
}
let STOCCACHE = null;
async function ensureStocCache() {
  try { STOCCACHE = { products: await api('/api/products'), gestiuni: await api('/api/gestiuni') }; }
  catch (_) { STOCCACHE = STOCCACHE || { products: [], gestiuni: [] }; }
  return STOCCACHE;
}
async function initStocEditor(ed, initLines) {
  await ensureStocCache();
  (initLines || []).forEach((l) => addStocRow(ed, l));
  if (!initLines || !initLines.length) addStocRow(ed, {});
  ed.querySelector('.addstoc').addEventListener('click', () => addStocRow(ed, {}));
  ed.addEventListener('click', (e) => { if (e.target.classList.contains('delstoc')) e.target.closest('.stoc-row').remove(); });
}
function addStocRow(ed, l) {
  const e = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const prods = (STOCCACHE && STOCCACHE.products) || [];
  const gests = (STOCCACHE && STOCCACHE.gestiuni) || [];
  const prodOpts = prods.length
    ? prods.map((p) => `<option value="${e(p.id)}" ${p.id === l.productId ? 'selected' : ''}>${e(p.cod)} — ${e(p.denumire)}</option>`).join('')
    : '<option value="">(niciun produs în nomenclator)</option>';
  const gestOpts = '<option value="">(fără gestiune)</option>' + gests.map((g) => `<option value="${e(g.id)}" ${g.id === l.gestiuneId ? 'selected' : ''}>${e(g.cod)} — ${e(g.denumire)}</option>`).join('');
  const row = document.createElement('div');
  row.className = 'stoc-row';
  row.innerHTML = `<select class="st-prod">${prodOpts}</select>
    <select class="st-gest">${gestOpts}</select>
    <input class="st-cant" type="number" step="0.001" placeholder="Cant." value="${l.cantitate != null ? l.cantitate : ''}">
    <button type="button" class="btn ghost small delstoc">✕</button>`;
  ed.querySelector('.stoc-rows').appendChild(row);
}
function readStoc(ed) {
  return [...ed.querySelectorAll('.stoc-row')].map((r) => ({
    productId: r.querySelector('.st-prod').value,
    gestiuneId: r.querySelector('.st-gest').value || null,
    cantitate: r.querySelector('.st-cant').value,
  })).filter((s) => s.productId && parseFloat(s.cantitate) > 0);
}
function collectFields() {
  const tip = META.types.find((t) => t.id === $('#tipSelect').value);
  const out = {};
  tip.fields.forEach((f) => {
    if (f.type === 'items') { const ed = $('#fld_' + f.name); if (ed) out[f.name] = readItems(ed); return; }
    if (f.type === 'stoc') { const ed = $('#fld_' + f.name); if (ed) out[f.name] = readStoc(ed); return; }
    if (f.type === 'checkbox') { const el = $('#fld_' + f.name); if (el) out[f.name] = el.checked; return; }
    const el = $('#fld_' + f.name); if (el) out[f.name] = el.value;
  });
  return out;
}
// ── Previzualizarea articolului contabil ──
// Vine de la server (POST /api/preview), prin ACEEASI compunere ca salvarea. Pana aici exista o
// replica locala a regulilor (localBuild): o a doua implementare a src/documentTypes/, care a
// deviat tacit (venit brut in loc de net la HoReCa, cota veche de 19%) si care oricum nu putea
// sti regulile ce depind de firma — pro-rata, TVA la incasare, deductibilitatea auto 50%,
// perioadele blocate. Acum previzualizarea arata exact articolul care se va salva.
// Se cere dupa o pauza de tastare (nu la fiecare tasta) si castiga mereu ultima cerere plecata.
let previewTimer = null;
let previewSeq = 0;
let previewTip = null;
const PREVIEW_DELAY = 350;
function renderPreviewLines(lines, total) {
  $('#preview').innerHTML = lines.map((l) => `<span class="pd">${H(l.debit)}</span> ${H(accName(l.debit))} = <span class="pc">${H(l.credit)}</span> ${H(accName(l.credit))}  →  <b>${fmt(l.suma)}</b> lei`).join('\n')
    + `\n──────────\nTotal articol: <b>${fmt(total)}</b> lei`;
}
async function requestPreview() {
  const tip = $('#tipSelect').value;
  const mine = ++previewSeq;
  let r;
  try {
    r = await api('/api/preview', {
      method: 'POST', quiet: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tip, fields: collectFields() }),
    });
  } catch (e) {
    if (mine !== previewSeq) return; // a plecat deja o cerere mai noua
    $('#preview').textContent = e.offline
      ? 'Previzualizarea are nevoie de conexiune. Câmpurile completate NU se pierd — reîncearcă după ce revii online.'
      : 'Previzualizarea nu e disponibilă acum: ' + e.message;
    return;
  }
  if (mine !== previewSeq) return; // raspuns intarziat pentru o stare veche a formularului
  if (r.ok) renderPreviewLines(r.lines, r.total);
  else $('#preview').textContent = r.mesaj || 'Completează câmpurile pentru a vedea articolul contabil.';
}
function updatePreview() {
  // La schimbarea tipului golim imediat: altfel, pana raspunde serverul, ar ramane pe ecran
  // articolul tipului ANTERIOR — cea mai proasta forma de previzualizare gresita.
  const tip = $('#tipSelect').value;
  if (tip !== previewTip) { previewTip = tip; $('#preview').textContent = 'Se calculează articolul contabil…'; }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(requestPreview, PREVIEW_DELAY);
}
async function submitEntry(ciorna) {
  try {
    const res = await api('/api/entries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tip: $('#tipSelect').value, fields: collectFields(), fileId: CURRENT && CURRENT.documentId, spvMsgId: CURRENT && CURRENT.spvMsgId, ciorna: !!ciorna }),
    });
    toast(ciorna ? 'Ciornă salvată: ' + res.entry.id + ' (o postezi din listă)' : 'Înregistrare salvată: ' + res.entry.id);
    closeForm();
    setMeta(await api('/api/meta')); fillPeriods();
    await loadEntries();
  } catch (err) { toast(err.message, true); }
}
$('#entryForm').addEventListener('submit', (e) => { e.preventDefault(); submitEntry(false); });
$('#saveDraft') && $('#saveDraft').addEventListener('click', () => submitEntry(true));

export { fillTipSelect, renderRecurring, setDocflowDeps };
