'use strict';

// Fluxul documentelor: upload + scanare (punte/camera), wizardul de tipuri, facturile recurente, SPV inbox + import e-Factura si formularul UNIC de inregistrare (mutat intre Documente/Emite).
// Extras din app.js (faza 2); apelurile inapoi spre app.js vin prin setDeps (fara cicluri).
import { $$, $, H, fmt, accName, toast, api, META, setMeta } from './core.js';
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
    `<optgroup label="${g}">${groups[g].map((t) => `<option value="${t.id}">${t.nume}</option>`).join('')}</optgroup>`
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
      + (res.motiv ? '<br><span class="muted">' + res.motiv + '</span>' : '')
      + (res.warning ? '<br><span data-u="u13">' + res.warning + '</span>' : '');
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
  if (sel && !sel.options.length) sel.innerHTML = (META.types || []).map((t) => `<option value="${t.id}">${t.nume}</option>`).join('');
  if ($('#recPeriod') && !$('#recPeriod').value) $('#recPeriod').value = workMonth();
  let list;
  try { list = await api('/api/recurring'); } catch (e) { return; }
  const box = $('#recList');
  if (!list.length) { box.innerHTML = '<p class="muted">Niciun șablon recurent definit încă.</p>'; return; }
  const tname = (id) => ((META.types || []).find((t) => t.id === id) || {}).nume || id;
  box.innerHTML = `<table><thead><tr><th>Document</th><th>Partener</th><th class="num">Bază</th><th>Frecvență</th><th>Din</th><th>Ultima</th><th></th></tr></thead><tbody>${
    list.map((t) => `<tr${t.activ ? '' : ' data-u="u21"'}><td>${tname(t.tip)}</td><td>${t.partener || '—'}</td>
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
  try { await api('/api/recurring', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); f.reset(); f.cota.value = 21; renderRecurring(); toast('Șablon recurent salvat'); }
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
      msgs.map((m) => `<tr><td>${m.data || ''}</td><td>${m.cif || ''}</td><td>${(m.detalii || '').slice(0, 60)}</td>
        <td>${m.importat ? '<span class="pill">importată</span>' : `<button class="linkbtn spvimp" data-id="${m.id}">importă</button>`}</td></tr>`).join('')}</tbody></table>`;
    $$('#inboxList .spvimp').forEach((b) => b.addEventListener('click', () => importFromSpv(b.dataset.id)));
  } catch (e) { box.innerHTML = `<p class="status err">${e.message}</p>`; }
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
  return META.accounts.map((a) => `<option value="${a.cod}" ${a.cod === String(val) ? 'selected' : ''}>${a.cod} — ${a.nume}</option>`).join('');
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
function localBuild(tipId, f) {
  // replica simplificata pentru previzualizare (server ramane sursa de adevar)
  const r2 = (x) => Math.round(x * 100) / 100;
  // daca exista linii detaliate, baza si TVA se calculeaza din ele
  if (Array.isArray(f.items) && f.items.length) {
    let b = 0; let t = 0;
    f.items.forEach((it) => { const x = r2((parseFloat(it.cantitate) || 0) * (parseFloat(it.pret) || 0)); b = r2(b + x); t = r2(t + (x * (parseFloat(it.cota) || 0)) / 100); });
    f.baza = b; f.tva = t;
  }
  const n = (x) => parseFloat(f[x]) || 0;
  const L = (d, c, s, e) => ({ debit: d, credit: c, suma: r2(s), explicatie: e });
  const m = {
    factura_vanzare_marfuri: () => [L('4111', '707', n('baza'), 'Venit marfuri'), n('tva') > 0 && L('4111', '4427', n('tva'), 'TVA colectata'), n('cost') > 0 && L('607', '371', n('cost'), 'Cost marfa')],
    factura_vanzare_produse: () => [L('4111', '701', n('baza'), 'Venit produse'), n('tva') > 0 && L('4111', '4427', n('tva'), 'TVA colectata')],
    factura_vanzare_servicii: () => [L('4111', '704', n('baza'), 'Venit servicii'), n('tva') > 0 && L('4111', '4427', n('tva'), 'TVA colectata')],
    bon_fiscal_z: () => [L(f.incasare || '5311', '707', n('baza'), 'Vanzare amanuntul'), n('tva') > 0 && L(f.incasare || '5311', '4427', n('tva'), 'TVA colectata')],
    factura_cumparare_marfuri: () => [L('371', '401', n('baza'), 'Marfuri'), n('tva') > 0 && L('4426', '401', n('tva'), 'TVA deductibila')],
    factura_cumparare_materii: () => [L(f.contStoc || '301', '401', n('baza'), 'Materii'), n('tva') > 0 && L('4426', '401', n('tva'), 'TVA deductibila')],
    factura_utilitati: () => [L('605', '401', n('baza'), 'Energie/apa'), n('tva') > 0 && L('4426', '401', n('tva'), 'TVA deductibila')],
    factura_servicii_primita: () => [L(f.contChelt || '628', '401', n('baza'), 'Servicii'), n('tva') > 0 && L('4426', '401', n('tva'), 'TVA deductibila')],
    factura_combustibil: () => [L('6022', '401', n('baza'), 'Combustibil'), n('tva') > 0 && L('4426', '401', n('tva'), 'TVA deductibila')],
    factura_imobilizare: () => [L(f.contImob || '2131', '404', n('baza'), 'Imobilizare'), n('tva') > 0 && L('4426', '404', n('tva'), 'TVA deductibila')],
    achizitie_intracomunitara: () => { const t = r2(n('baza') * (n('cota') || 19) / 100); return [L(f.contStoc || '371', '401', n('baza'), 'Achizitie IC'), L('4426', '4427', t, 'Taxare inversa')]; },
    livrare_intracomunitara: () => [L('4111', '707', n('baza'), 'Livrare IC')],
    incasare_client: () => [L(f.cont || '5121', '4111', n('suma'), 'Incasare client')],
    plata_furnizor: () => [L(f.contFz || '401', f.cont || '5121', n('suma'), 'Plata furnizor')],
    depunere_numerar: () => [L('581', '5311', n('suma'), 'Ridicare casa'), L('5121', '581', n('suma'), 'Depunere banca')],
    ridicare_numerar: () => [L('581', '5121', n('suma'), 'Ridicare banca'), L('5311', '581', n('suma'), 'Intrare casa')],
    comision_bancar: () => [L('627', '5121', n('suma'), 'Comision bancar')],
    stat_plata: () => {
      let cas = n('cas'); let cass = n('cass'); let imp = n('impozit'); let cam = n('cam');
      const fp = (META.fiscal) || { cas: 25, cass: 10, impozitVenit: 10, cam: 2.25 };
      if (n('brut') > 0 && !cas && !cass && !imp && !cam) {
        cas = r2(n('brut') * fp.cas / 100); cass = r2(n('brut') * fp.cass / 100);
        const baza = Math.max(0, r2(n('brut') - cas - cass - n('neimpozabil')));
        imp = r2(baza * fp.impozitVenit / 100); cam = r2(n('brut') * fp.cam / 100);
      }
      return [L('641', '421', n('brut'), 'Salarii brute'), cas > 0 && L('421', '4315', cas, 'CAS'), cass > 0 && L('421', '4316', cass, 'CASS'), imp > 0 && L('421', '444', imp, 'Impozit'), cam > 0 && L('646', '436', cam, 'CAM')];
    },
    avans_incasat_client: () => [L(f.cont || '5121', '419', n('suma'), 'Avans incasat client')],
    avans_platit_furnizor: () => [L('409', f.cont || '5121', n('suma'), 'Avans platit furnizor')],
    lucrari_in_curs: () => f.sens === 'reluare' ? [L('712', '332', n('suma'), 'Reluare lucrari in curs')] : [L('332', '712', n('suma'), 'Lucrari in curs')],
    garantie_retinuta: () => [L('2678', '4111', n('suma'), 'Garantie retinuta')],
    garantie_restituita: () => [L(f.cont || '5121', '2678', n('suma'), 'Restituire garantie')],
    horeca_intrare: () => { const o = [L('371', '401', n('cost'), 'Marfa la cost')]; if (n('tvaDed') > 0) o.push(L('4426', '401', n('tvaDed'), 'TVA deductibila')); if (n('adaos') > 0) o.push(L('371', '378', n('adaos'), 'Adaos')); const tn = r2((n('cost') + n('adaos')) * (n('cotaVanzare') || 11) / 100); if (tn > 0) o.push(L('371', '4428', tn, 'TVA neexigibila')); return o; },
    horeca_vanzare: () => { const o = []; if (n('numerar') > 0) o.push(L('5311', '707', n('numerar'), 'Numerar')); if (n('card') > 0) o.push(L('5121', '707', n('card'), 'Card')); const tot = r2(n('numerar') + n('card')); const c = n('cota') || 11; const tc = r2(tot * c / (100 + c)); if (tc > 0) o.push(L('4428', '4427', tc, 'TVA colectata')); if (n('cost') > 0) o.push(L('607', '371', n('cost'), 'Cost')); if (n('adaos') > 0) o.push(L('378', '371', n('adaos'), 'Adaos')); return o; },
    diferenta_curs: () => f.sens === 'nefavorabila' ? [L('665', f.contTert || '401', n('suma'), 'Diferenta nefavorabila')] : [L(f.contTert || '5124', '765', n('suma'), 'Diferenta favorabila')],
    combustibil_50: () => { const tt = r2(n('baza') * (n('cota') || 21) / 100); const td = r2(tt * 0.5); const tn = r2(tt - td); const o = [L('6022', '401', n('baza'), 'Combustibil')]; if (td > 0) o.push(L('4426', '401', td, 'TVA ded. 50%')); if (tn > 0) o.push(L('6022', '401', tn, 'TVA nded. 50%')); return o; },
    taxe_drum: () => [L('635', '446', n('suma'), 'Rovinieta/taxe drum')],
    plata_salarii: () => [L('421', f.cont || '5121', n('suma'), 'Plata salarii')],
    amortizare: () => [L('6811', f.contAmort || '281', n('suma'), 'Amortizare')],
    factura_storno_vanzare: () => [L('4111', '707', -n('baza'), 'Storno venit'), n('tva') > 0 && L('4111', '4427', -n('tva'), 'Storno TVA colectata')],
    factura_storno_cumparare: () => [L(f.contStoc || '371', '401', -n('baza'), 'Storno achizitie'), n('tva') > 0 && L('4426', '401', -n('tva'), 'Storno TVA deductibila')],
    bon_consum: () => [L(f.contChelt || '601', f.contStoc || '301', n('suma'), 'Consum din stoc')],
    acordare_avans: () => [L('542', f.cont || '5311', n('suma'), 'Avans de trezorerie acordat')],
    decont_deplasare: () => [L(f.contChelt || '625', f.cont || '542', n('suma'), 'Decont deplasare')],
    dobanda_bancara: () => [L('666', '5121', n('suma'), 'Cheltuieli cu dobanzile')],
    import_vamal: () => { const baza = r2(n('valoareBunuri') + n('taxeVamale')); const tva = r2(baza * (n('cota') || 21) / 100); const o = [L(f.contBun || '371', '401', n('valoareBunuri'), 'Import bunuri')]; if (n('taxeVamale') > 0) o.push(L(f.contBun || '371', '446', n('taxeVamale'), 'Taxe vamale')); o.push(L('4426', '446', tva, 'TVA in vama')); return o; },
    diferente_inventar: () => f.sens === 'plus' ? [L(f.contStoc || '371', f.contChelt || '607', n('suma'), 'Plus la inventar')] : [L(f.contChelt || '607', f.contStoc || '371', n('suma'), 'Minus la inventar')],
    casare_mijloc_fix: () => { const ramas = r2(n('valoare') - n('amortizare')); const o = []; if (n('amortizare') > 0) o.push(L(f.contAmort || '281', f.contImob || '2131', n('amortizare'), 'Scadere amortizare')); if (ramas > 0) o.push(L('6583', f.contImob || '2131', ramas, 'Valoare ramasa')); return o; },
    imputare_lipsa: () => { const tva = r2(n('valoareImputata') * (n('cota') || 21) / 100); const o = [L(f.contCreanta || '4282', '7588', n('valoareImputata'), 'Imputare lipsa - venit')]; if (tva > 0) o.push(L(f.contCreanta || '4282', '4427', tva, 'TVA imputare')); return o; },
    plata_taxe: () => [L(f.contTaxa || '446', f.cont || '5121', n('suma'), 'Plata taxe/impozite')],
    nota_contabila: () => [L(f.debit || '?', f.credit || '?', n('suma'), f.explicatie || 'Nota')],
  };
  return (m[tipId] ? m[tipId]() : []).filter(Boolean);
}
function updatePreview() {
  const tipId = $('#tipSelect').value;
  const f = collectFields();
  const lines = localBuild(tipId, f);
  const total = lines.reduce((s, l) => s + l.suma, 0);
  $('#preview').innerHTML = lines.length
    ? lines.map((l) => `<span class="pd">${l.debit}</span> ${accName(l.debit)} = <span class="pc">${l.credit}</span> ${accName(l.credit)}  →  <b>${fmt(l.suma)}</b> lei`).join('\n')
      + `\n──────────\nTotal articol: <b>${fmt(total)}</b> lei`
    : 'Completează câmpurile pentru a vedea articolul contabil.';
}
$('#entryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await api('/api/entries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tip: $('#tipSelect').value, fields: collectFields(), fileId: CURRENT && CURRENT.documentId, spvMsgId: CURRENT && CURRENT.spvMsgId }),
    });
    toast('Înregistrare salvată: ' + res.entry.id);
    closeForm();
    setMeta(await api('/api/meta')); fillPeriods();
    await loadEntries();
  } catch (err) { toast(err.message, true); }
});

export { fillTipSelect, renderRecurring, setDocflowDeps };
