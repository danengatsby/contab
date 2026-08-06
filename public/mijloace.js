'use strict';

// Mijloace fixe: registru, fisa, amortizare lunara. Extras din app.js (Etapa: spargerea fisierului mare).
import { $$, $, H, fmt, toast, api } from './core.js';
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
        <td>${H(a.denumire)}${a.status === 'casat' ? ' <span class="pill">casat</span>' : ''}</td>
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
  // Planul fiscal se trimite doar daca a fost ales; serverul ignora oricum valorile egale cu cele
  // contabile, dar nu are rost sa le trimitem.
  if (f.metodaFiscala && f.metodaFiscala.value) body.metodaFiscala = f.metodaFiscala.value;
  if (f.durataFiscalaLuni && f.durataFiscalaLuni.value) body.durataFiscalaLuni = f.durataFiscalaLuni.value;
  // Plafonul auto (art. 28 alin. (12) lit. m) se trimite doar cand e bifat: marcaj explicit.
  if (f.vehiculM1 && f.vehiculM1.checked) body.vehiculM1 = true;
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


// ───────────────────────── CONTRACTE DE LEASING ─────────────────────────
// Nomenclatorul care alimentează factura de rată. Graficul se derivă din contract pe server;
// aici doar se afișează — regula de calcul are o singură implementare.
async function loadLeasingContracts() {
  let list = [];
  try { list = await api('/api/leasing-contracts'); } catch (err) { $('#lcList').innerHTML = `<p class="status err">${H(err.message)}</p>`; return; }
  $('#lcList').innerHTML = list.length
    ? `<table><thead><tr><th>Contract</th><th>Locator</th><th class="num">Finanțat</th><th class="num">Rate</th><th class="num">Dobândă</th><th>Perioadă</th><th class="num">Total dobândă</th><th></th></tr></thead><tbody>${
      list.map((c) => `<tr><td>${H(c.denumire)}${c.document ? ' <span class="muted">' + H(c.document) + '</span>' : ''}</td><td>${H(c.partener)}</td>
        <td class="num">${fmt(c.principal)}</td><td class="num">${c.months}</td><td class="num">${fmt(c.dobandaAnuala)}%</td>
        <td>${H(c.primaRata || '')} … ${H(c.ultimaRata || '')}</td><td class="num">${fmt(c.totals.dobanda)}</td>
        <td><button class="linkbtn lcgraf" data-id="${H(c.id)}">grafic</button> · <button class="linkbtn lcedit" data-id="${H(c.id)}">editează</button> · <button class="linkbtn lcdel" data-id="${H(c.id)}">șterge</button></td></tr>`).join('')}
      </tbody></table>`
    : '<p class="muted">Niciun contract de leasing. Adaugă unul în formular.</p>';
  $('#lcList').dataset.json = JSON.stringify(list);
}
$('#lcForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { id: f.id.value || undefined, denumire: f.denumire.value, partener: f.partener.value, cui: f.cui.value,
    document: f.document.value, principal: f.principal.value, months: f.months.value,
    dobandaAnuala: f.dobandaAnuala.value, dataPrimeiRate: f.dataPrimeiRate.value, cotaTva: f.cotaTva.value, metoda: f.metoda.value };
  try {
    await api('/api/leasing-contracts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast('Contract salvat'); f.reset(); f.id.value = '';
    loadLeasingContracts();
  } catch (err) { toast(err.message, true); }
});
$('#lcList').addEventListener('click', async (e) => {
  const id = e.target.dataset.id; if (!id) return;
  const list = JSON.parse($('#lcList').dataset.json || '[]');
  const c = list.find((x) => x.id === id); if (!c) return;
  if (e.target.classList.contains('lcedit')) {
    const f = $('#lcForm');
    for (const k of ['id', 'denumire', 'partener', 'cui', 'document', 'principal', 'months', 'dobandaAnuala', 'dataPrimeiRate', 'cotaTva', 'metoda']) if (f[k]) f[k].value = c[k] != null ? c[k] : '';
    f.scrollIntoView({ block: 'center' });
  } else if (e.target.classList.contains('lcdel')) {
    if (!confirm('Ștergi contractul „' + c.denumire + '"?')) return;
    try { await api('/api/leasing-contracts/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Contract șters'); loadLeasingContracts(); $('#lcSchedule').innerHTML = ''; } catch (err) { toast(err.message, true); }
  } else if (e.target.classList.contains('lcgraf')) {
    try {
      const r = await api('/api/leasing-contracts/' + encodeURIComponent(id) + '/schedule');
      $('#lcSchedule').innerHTML = `<h3>Grafic — ${H(c.denumire)}</h3><table><thead><tr><th class="num">Luna</th><th>Perioadă</th><th class="num">Rată</th><th class="num">Principal</th><th class="num">Dobândă</th><th class="num">TVA</th><th class="num">Sold rămas</th></tr></thead><tbody>${
        r.schedule.rows.map((x) => `<tr><td class="num">${x.luna}</td><td>${H(x.period || '')}</td><td class="num">${fmt(x.rata)}</td><td class="num">${fmt(x.principal)}</td><td class="num">${fmt(x.dobanda)}</td><td class="num">${fmt(x.tva)}</td><td class="num">${fmt(x.sold)}</td></tr>`).join('')}
        <tr class="bold"><td colspan="2">TOTAL</td><td class="num">${fmt(r.schedule.totals.rata)}</td><td class="num">${fmt(r.schedule.totals.principal)}</td><td class="num">${fmt(r.schedule.totals.dobanda)}</td><td class="num">${fmt(r.schedule.totals.tva)}</td><td></td></tr></tbody></table>`;
    } catch (err) { toast(err.message, true); }
  }
});

export { loadAssets, loadLeasingContracts };
