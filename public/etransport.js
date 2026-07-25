'use strict';

// Formular ghidat RO e-Transport (cod UIT): pe articolele eligibile (aviz, livrari/achizitii
// IC, import, vanzari de marfuri) butonul „e-Transport" deschide un modal cu datele de transport
// (vehicul, traseu, greutati, cod NC), apoi Verifica -> Trimite (obtine UIT direct din SPV).
// Autonom: se activeaza prin import (efect secundar — inregistrarea handler-ului delegat), ca
// viewer.js. Reincarcarea listei dupa succes se face inlocuind in DOM butonul cu insigna UIT
// (fara sa presupunem ce tab e activ). Depinde doar de core.js + loadEntries pentru re-render.

import { $, H, api, toast, META } from './core.js';

// Tipul operatiunii dedus din tipul articolului (identic cu defaultTipOperatiune din src/etransport.js)
function defaultTip(tip) {
  if (tip === 'livrare_intracomunitara') return '20';
  if (tip === 'achizitie_intracomunitara') return '10';
  if (tip === 'import_vamal') return '40';
  return '30';
}

let NOM = null; // nomenclatoarele (o singura data)
async function nomenclatoare() {
  if (!NOM) NOM = await api('/api/etransport/nomenclatoare');
  return NOM;
}

function opts(map, selected) {
  return Object.keys(map).map((k) => `<option value="${H(k)}"${String(k) === String(selected) ? ' selected' : ''}>${H(k)} — ${H(map[k])}</option>`).join('');
}

// Construieste (o singura data) scheletul modalului si il intoarce.
function ensureModal() {
  let m = $('#etModal');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'etModal';
  m.className = 'pdf-modal hidden';
  m.innerHTML = `
    <div class="card" data-style="width:min(760px,96vw);max-height:92vh;overflow:auto;background:var(--card)">
      <div class="card-head"><h3 data-style="margin:0">🚚 e-Transport — obținere cod UIT</h3>
        <button id="etClose" class="btn small ghost" title="Închide">✕</button></div>
      <p class="muted" data-u="u22">Declarația transportului de bunuri (OUG 41/2022). Completează vehiculul și traseul; marfa e preluată din document. Verifică, apoi trimite pentru codul UIT.</p>
      <form id="etForm">
        <div data-style="display:grid;grid-template-columns:1fr 1fr;gap:2px 14px">
          <label>Tip operațiune <select name="codTipOperatiune" id="etTip"></select></label>
          <label>Scop operațiune <select name="codScopOperatiune" id="etScop"></select></label>
        </div>
        <div data-style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:2px 14px">
          <label>Cod tarifar (NC, 4-8 cifre) <input name="codTarifar" id="etNc" inputmode="numeric" placeholder="ex. 48191000"></label>
          <label>Greutate netă (kg) <input name="greutateNeta" id="etGn" type="number" step="0.01" min="0"></label>
          <label>Greutate brută (kg) <input name="greutateBruta" id="etGb" type="number" step="0.01" min="0"></label>
        </div>
        <div data-style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px 14px">
          <label>Nr. înmatriculare vehicul <input name="nrVehicul" id="etVeh" placeholder="ex. CJ01ABC" autocomplete="off"></label>
          <label>Nr. remorcă (opțional) <input name="nrRemorca1" placeholder="ex. CJ02DEF" autocomplete="off"></label>
          <label>Data transportului <input name="dataTransport" type="date"></label>
        </div>
        <div class="muted" data-u="u24"><b>Plecare</b></div>
        <div data-style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:2px 14px">
          <label>Județ <input name="startJudet" placeholder="ex. Cluj"></label>
          <label>Localitate <input name="startLocalitate"></label>
          <label>Stradă / nr. <input name="startStrada"></label>
        </div>
        <div class="muted" data-u="u24"><b>Sosire</b></div>
        <div data-style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:2px 14px">
          <label>Județ <input name="finalJudet" placeholder="ex. București"></label>
          <label>Localitate <input name="finalLocalitate"></label>
          <label>Stradă / nr. <input name="finalStrada"></label>
        </div>
      </form>
      <div id="etResult" data-u="u18"></div>
      <div data-style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
        <button id="etCheck" class="btn small">🔍 Verifică</button>
        <a id="etXml" class="btn small" target="_blank" rel="noopener">📄 Vezi XML</a>
        <button id="etSend" class="btn small primary">📤 Trimite (obține UIT)</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  // inchidere: X, click pe fundal, Escape
  $('#etClose').addEventListener('click', closeForm);
  m.addEventListener('click', (e) => { if (e.target.id === 'etModal') closeForm(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !m.classList.contains('hidden')) closeForm(); });
  // actiuni
  $('#etCheck').addEventListener('click', onCheck);
  $('#etSend').addEventListener('click', onSend);
  // linkul XML trece prin vizualizatorul intern (viewer.js intercepteaza /xml/*)
  $('#etForm').addEventListener('input', refreshXmlHref);
  return m;
}

let CURRENT = null; // { id, tip, nc, data }

function tdFromForm() {
  const f = $('#etForm');
  const g = (n) => (f.elements[n] ? f.elements[n].value.trim() : '');
  return {
    codTipOperatiune: g('codTipOperatiune'), codScopOperatiune: g('codScopOperatiune'),
    codTarifar: g('codTarifar'), greutateNeta: g('greutateNeta'), greutateBruta: g('greutateBruta'),
    nrVehicul: g('nrVehicul'), nrRemorca1: g('nrRemorca1'), dataTransport: g('dataTransport'),
    startJudet: g('startJudet'), startLocalitate: g('startLocalitate'), startStrada: g('startStrada'),
    finalJudet: g('finalJudet'), finalLocalitate: g('finalLocalitate'), finalStrada: g('finalStrada'),
  };
}

// Reflecta datele din formular in href-ul linkului „Vezi XML" (deschis prin viewer.js).
function refreshXmlHref() {
  if (!CURRENT) return;
  const td = tdFromForm();
  const q = Object.keys(td).filter((k) => td[k] !== '').map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(td[k])).join('&');
  $('#etXml').href = '/xml/etransport/' + encodeURIComponent(CURRENT.id) + (q ? '?' + q : '');
}

function showResult(html) { $('#etResult').innerHTML = html; }

async function onCheck() {
  if (!CURRENT) return;
  try {
    const r = await api('/api/etransport/validate/' + encodeURIComponent(CURRENT.id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tdFromForm()),
    });
    renderValidation(r);
  } catch (e) { toast(e.message, true); }
}

function renderValidation(r) {
  const err = (r.errors || []).map((x) => `<li>${H(x)}</li>`).join('');
  const warn = (r.warnings || []).map((x) => `<li>${H(x)}</li>`).join('');
  let html = '';
  if (r.ok) html += `<div class="status ok" data-style="color:var(--good)">✓ Declarația e completă — poți trimite pentru codul UIT.</div>`;
  if (err) html += `<div class="status err">De completat înainte de trimitere:<ul data-style="margin:4px 0 0 18px">${err}</ul></div>`;
  if (warn) html += `<div class="muted" data-u="u24">De verificat:<ul data-style="margin:4px 0 0 18px">${warn}</ul></div>`;
  showResult(html);
}

async function onSend() {
  if (!CURRENT) return;
  const btn = $('#etSend'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'se trimite…';
  try {
    const r = await api('/api/etransport/send/' + encodeURIComponent(CURRENT.id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tdFromForm()),
    });
    const et = r.etransport || {};
    if (et.uit) {
      toast('Cod UIT obținut: ' + et.uit);
      showResult(`<div class="status ok" data-style="color:var(--good)">✓ Cod UIT: <b>${H(et.uit)}</b> (valabil pentru transport). Închide fereastra.</div>`);
      markUit(CURRENT.id, et.uit);
      setTimeout(closeForm, 1800);
    } else {
      toast('Trimis — UIT în prelucrare (verifică starea).');
      showResult(`<div class="muted" data-u="u24">Trimis (index ${H(et.index || '')}). Codul UIT apare după procesare — reîncearcă în câteva momente.</div>`);
    }
  } catch (e) {
    // erorile de validare vin ca „Declaratie incompleta: ..." (400) — afiseaza-le explicit
    showResult(`<div class="status err">${H(e.message)}</div>`);
  } finally { btn.disabled = false; btn.textContent = old; }
}

// Inlocuieste in DOM butonul e-Transport (ambele randari) cu insigna UIT — fara reincarcare de tab.
function markUit(id, uit) {
  document.querySelectorAll('.ettrans[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]').forEach((b) => {
    const span = document.createElement('span');
    span.className = 'pill'; span.title = 'Cod UIT e-Transport obtinut'; span.textContent = 'UIT ' + uit;
    b.replaceWith(span);
  });
}

function closeForm() { const m = $('#etModal'); if (m) m.classList.add('hidden'); }

async function openForm(ds) {
  CURRENT = { id: ds.id, tip: ds.tip || '', nc: ds.nc || '', data: ds.data || '' };
  ensureModal();
  let nom;
  try { nom = await nomenclatoare(); } catch (e) { toast('Nu s-au putut încărca nomenclatoarele e-Transport: ' + e.message, true); return; }
  const f = $('#etForm');
  $('#etTip').innerHTML = opts(nom.tipOperatiune, defaultTip(CURRENT.tip));
  $('#etScop').innerHTML = opts(nom.scopOperatiune, '101');
  // prefill: marfa (cod NC din intrastat) + data + plecarea din sediul firmei
  const c = META.company || {};
  f.elements.codTarifar.value = CURRENT.nc || '';
  f.elements.greutateNeta.value = ''; f.elements.greutateBruta.value = '';
  f.elements.nrVehicul.value = ''; f.elements.nrRemorca1.value = '';
  f.elements.dataTransport.value = CURRENT.data || new Date().toISOString().slice(0, 10);
  f.elements.startJudet.value = c.judet || ''; f.elements.startLocalitate.value = c.oras || ''; f.elements.startStrada.value = c.adresa || '';
  f.elements.finalJudet.value = ''; f.elements.finalLocalitate.value = ''; f.elements.finalStrada.value = '';
  showResult('');
  refreshXmlHref();
  $('#etModal').classList.remove('hidden');
  f.elements.nrVehicul.focus();
}

// Handler delegat global: prinde butonul .ettrans din orice randare (lista recenta sau arhiva).
document.addEventListener('click', (e) => {
  const b = e.target.closest('.ettrans');
  if (!b) return;
  e.preventDefault();
  openForm(b.dataset);
});

// Exportat pentru testele unitare de frontend (clasificarea operatiunii e-Transport): test/frontend.mjs
export { defaultTip };
