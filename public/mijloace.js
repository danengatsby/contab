'use strict';

// Mijloace fixe: registru, fisa, amortizare lunara. Extras din app.js (Etapa: spargerea fisierului mare).
import { $$, $, fmt, toast, api } from './core.js';
import { pget, onPeriodChange } from './periods.js';

// ───────────────────────── MIJLOACE FIXE ─────────────────────────
function mfAsOf() { return pget('mf') || new Date().toISOString().slice(0, 7); }
async function loadAssets() {
  const asOf = mfAsOf();
  $('#mfRegPdf').href = '/pdf/assets?asOf=' + asOf;
  const list = await api('/api/assets?asOf=' + asOf);
  $('#assetsList').innerHTML = list.length
    ? `<table><thead><tr><th>Denumire</th><th>Cont</th><th>Metodă</th><th>Data PIF</th><th class="num">Cost</th><th class="num">Amort./lună</th><th class="num">Cumulat</th><th class="num">Rămas</th><th></th></tr></thead><tbody>${
      list.map((a) => `<tr${a.status === 'casat' ? ' class="muted"' : ''}>
        <td>${a.denumire}${a.status === 'casat' ? ' <span class="pill">casat</span>' : ''}</td>
        <td class="acc">${a.cont}/${a.calc.contAmortizare}</td>
        <td>${({ liniara: 'liniară', degresiva: 'degresivă', accelerata: 'accelerată' })[a.metoda] || a.metoda}</td>
        <td>${a.dataPif}</td>
        <td class="num">${fmt(a.cost)}</td>
        <td class="num">${fmt(a.calc.amortizareLunara)}</td>
        <td class="num">${fmt(a.calc.amortizareCumulata)}</td>
        <td class="num">${fmt(a.calc.valoareRamasa)}</td>
        <td><a class="linkbtn" href="/pdf/asset/${a.id}?asOf=${asOf}" target="_blank">fișă</a>
          ${a.status !== 'casat' ? ` · <button class="linkbtn amf-scrap" data-id="${a.id}">casează</button>` : ''}
          · <button class="linkbtn amf-del" data-id="${a.id}">șterge</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Niciun mijloc fix înregistrat.</p>';
  $$('#assetsList .amf-del').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi acest mijloc fix?')) return;
    await api('/api/assets/' + b.dataset.id, { method: 'DELETE' }); loadAssets(); toast('Mijloc fix șters');
  }));
  $$('#assetsList .amf-scrap').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/assets/' + b.dataset.id + '/scrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    loadAssets(); toast('Mijloc fix casat');
  }));
}
onPeriodChange('mf', loadAssets);
function lsQuery() { const f = $('#lsForm'); return 'principal=' + f.principal.value + '&months=' + f.months.value + '&rate=' + f.rate.value + '&method=' + f.method.value; }
$('#lsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#lsPdf').href = '/pdf/leasing-schedule?' + lsQuery();
  const s = await api('/api/leasing-schedule?' + lsQuery());
  $('#lsView').innerHTML = `<table><thead><tr><th class="num">Luna</th><th class="num">Rată</th><th class="num">Principal</th><th class="num">Dobândă</th><th class="num">Sold rămas</th></tr></thead><tbody>${
    s.rows.map((r) => `<tr><td class="num">${r.luna}</td><td class="num">${fmt(r.rata)}</td><td class="num">${fmt(r.principal)}</td><td class="num">${fmt(r.dobanda)}</td><td class="num">${fmt(r.sold)}</td></tr>`).join('')}
    <tr class="bold"><td class="num">TOTAL</td><td class="num">${fmt(s.totals.rata)}</td><td class="num">${fmt(s.totals.principal)}</td><td class="num">${fmt(s.totals.dobanda)}</td><td></td></tr></tbody></table>`;
});
$('#assetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { denumire: f.denumire.value, cont: f.cont.value, cost: f.cost.value, durataLuni: f.durataLuni.value, metoda: f.metoda.value, valoareReziduala: f.valoareReziduala.value, dataAchizitie: f.dataAchizitie.value, dataPif: f.dataPif.value, furnizor: f.furnizor.value, cui: f.cui.value };
  try { await api('/api/assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast('Mijloc fix adăugat'); f.reset(); f.valoareReziduala.value = '0'; loadAssets(); }
  catch (err) { toast(err.message, true); }
});
$('#mfDeprec').addEventListener('click', async () => {
  const period = mfAsOf();
  try {
    const r = await api('/api/assets/depreciation?period=' + period, { method: 'POST' });
    toast(r.message || ('Amortizare înregistrată pentru ' + period + ' (' + (r.result.lines || []).length + ' MF)'));
    loadAssets();
  } catch (err) { toast(err.message, true); }
});


export { loadAssets };
