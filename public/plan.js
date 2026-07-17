'use strict';

// Planul de conturi: afisare pe clase + import CSV personalizat. Extras din app.js (Etapa: spargerea fisierului mare).
import { $$, $, fmt, accName, toast, api, META, setMeta, fileToCsv } from './core.js';

// ───────────────────────── PLAN ─────────────────────────
$('#planFilter').addEventListener('input', renderPlan);
$('#accCsvFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) { try { $('#accCsvIn').value = await fileToCsv(f); } catch (err) { toast(err.message, true); } } });
$('#accImportBtn').addEventListener('click', async () => {
  const csv = $('#accCsvIn').value.trim(); if (!csv) return toast('Lipiește un CSV', true);
  try {
    const r = await api('/api/accounts/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
    toast(r.importati + ' conturi importate (' + r.totalConturi + ' total)');
    $('#accCsvIn').value = ''; setMeta(await api('/api/meta')); renderPlan();
  } catch (err) { toast(err.message, true); }
});
function renderPlan() {
  const q = ($('#planFilter').value || '').toLowerCase();
  const rows = META.accounts.filter((a) => !q || a.cod.includes(q) || a.nume.toLowerCase().includes(q))
    .map((a) => `<tr><td class="acc">${a.cod}</td><td>${a.nume}</td><td>Clasa ${a.clasa}</td><td>${a.tip}</td></tr>`).join('');
  $('#planView').innerHTML = `<table><thead><tr><th>Cont</th><th>Denumire</th><th>Clasa</th><th>Tip</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ── Mod simplu (necontabil) + Dictionar contabil ──
// Extrase in public/simplemode.js (initUiMode e apelat din init).

// ── Solduri inițiale (editor, Setări → preluare firmă cu istoric) ──
let OPEN_ROWS = [];
function nrRo(s) {
  s = String(s == null ? '' : s).trim().replace(/\s/g, '').replace(/lei|ron/gi, '');
  if (!s) return 0;
  if (s.includes('.') && s.includes(',')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
async function renderOpening() {
  let map; try { map = await api('/api/opening'); } catch (e) { return; }
  OPEN_ROWS = Object.keys(map).sort().map((cont) => ({ cont, d: Number(map[cont].d) || 0, c: Number(map[cont].c) || 0 }));
  drawOpening();
}
function drawOpening() {
  const rows = OPEN_ROWS.map((r, i) => `<tr>
    <td><input class="op-cont acc" data-i="${i}" value="${r.cont}" placeholder="cont" style="width:90px" /></td>
    <td class="muted op-nume">${accName(r.cont) || ''}</td>
    <td><input class="op-d num" data-i="${i}" type="number" step="0.01" value="${r.d || ''}" placeholder="0" style="width:120px;text-align:right" /></td>
    <td><input class="op-c num" data-i="${i}" type="number" step="0.01" value="${r.c || ''}" placeholder="0" style="width:120px;text-align:right" /></td>
    <td><button class="linkbtn op-del" data-i="${i}">șterge</button></td></tr>`).join('');
  $('#openEditor').innerHTML = OPEN_ROWS.length
    ? `<table><thead><tr><th>Cont</th><th>Denumire</th><th class="num">Sold debit</th><th class="num">Sold credit</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">Niciun sold inițial. Adaugă conturi sau încarcă balanța din fișier.</p>';
  const totD = Math.round(OPEN_ROWS.reduce((s, r) => s + (r.d || 0), 0) * 100) / 100;
  const totC = Math.round(OPEN_ROWS.reduce((s, r) => s + (r.c || 0), 0) * 100) / 100;
  const dif = Math.round((totD - totC) * 100) / 100;
  $('#openTotals').innerHTML = OPEN_ROWS.length
    ? `Total debit: <b>${fmt(totD)}</b> · Total credit: <b>${fmt(totC)}</b> · ${dif === 0 ? '<span style="color:var(--accent);font-weight:700">echilibrat ✓</span>' : `<span style="color:#b00020;font-weight:700">diferență ${fmt(dif)}</span>`}`
    : '';
  $$('#openEditor .op-cont').forEach((inp) => inp.addEventListener('input', (e) => {
    const r = OPEN_ROWS[Number(e.target.dataset.i)]; r.cont = e.target.value.trim();
    e.target.closest('tr').querySelector('.op-nume').textContent = accName(r.cont) || '';
  }));
  $$('#openEditor .op-d').forEach((inp) => inp.addEventListener('input', (e) => { OPEN_ROWS[Number(e.target.dataset.i)].d = Number(e.target.value) || 0; drawOpeningTotals(); }));
  $$('#openEditor .op-c').forEach((inp) => inp.addEventListener('input', (e) => { OPEN_ROWS[Number(e.target.dataset.i)].c = Number(e.target.value) || 0; drawOpeningTotals(); }));
  $$('#openEditor .op-del').forEach((b) => b.addEventListener('click', () => { OPEN_ROWS.splice(Number(b.dataset.i), 1); drawOpening(); }));
}
function drawOpeningTotals() {
  const totD = Math.round(OPEN_ROWS.reduce((s, r) => s + (r.d || 0), 0) * 100) / 100;
  const totC = Math.round(OPEN_ROWS.reduce((s, r) => s + (r.c || 0), 0) * 100) / 100;
  const dif = Math.round((totD - totC) * 100) / 100;
  $('#openTotals').innerHTML = `Total debit: <b>${fmt(totD)}</b> · Total credit: <b>${fmt(totC)}</b> · ${dif === 0 ? '<span style="color:var(--accent);font-weight:700">echilibrat ✓</span>' : `<span style="color:#b00020;font-weight:700">diferență ${fmt(dif)}</span>`}`;
}
$('#openAddRow') && $('#openAddRow').addEventListener('click', () => { OPEN_ROWS.push({ cont: '', d: 0, c: 0 }); drawOpening(); });
$('#openFile') && $('#openFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  let csv; try { csv = await fileToCsv(f); } catch (err) { return toast(err.message, true); }
  const lines = csv.split(/\r?\n/).map((l) => l.replace(/^﻿/, '')).filter((l) => l.trim());
  const rows = [];
  for (const line of lines) {
    const cells = line.split(';');
    const cont = String(cells[0] || '').trim();
    if (!cont || !/^\d/.test(cont)) continue; // sare antetul si randurile fara cont
    const d = nrRo(cells[2]); const c = nrRo(cells[3]);
    if (d === 0 && c === 0) continue;
    rows.push({ cont, d, c });
  }
  if (!rows.length) return toast('Nicio linie cu solduri găsită (aștept coloane Cont;Denumire;SoldDebit;SoldCredit)', true);
  OPEN_ROWS = rows;
  drawOpening();
  toast(rows.length + ' conturi încărcate — verifică echilibrul și salvează');
  e.target.value = '';
});
$('#openSaveBtn') && $('#openSaveBtn').addEventListener('click', async () => {
  const ob = {};
  for (const r of OPEN_ROWS) {
    if (!r.cont) continue;
    const prev = ob[r.cont] || { d: 0, c: 0 };
    ob[r.cont] = { d: Math.round((prev.d + (r.d || 0)) * 100) / 100, c: Math.round((prev.c + (r.c || 0)) * 100) / 100 };
  }
  const s = $('#openStatus');
  try {
    const r = await api('/api/opening', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openingBalances: ob }) });
    s.className = 'status ok';
    s.textContent = 'Solduri inițiale salvate (' + Object.keys(ob).length + ' conturi, debit = credit = ' + fmt(r.totalDebit) + ' lei).';
    toast('Solduri inițiale salvate');
  } catch (err) { s.className = 'status err'; s.textContent = err.message; }
});


export { renderOpening, renderPlan };
