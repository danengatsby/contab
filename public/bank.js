'use strict';
// Import extras bancar (CSV / MT940): parseaza extrasul, potriveste partenerii dupa
// descriere, propune incasari/plati de confirmat si le importa ca inregistrari. Extras din
// app.js (Etapa 2 a modularizarii). Depinde de nucleu; reimprospatarea post-import
// (fillPeriods + loadEntries + loadDashboard) e INJECTATA de app.js prin setBankRefresh,
// ca sa nu apara o dependenta circulara bank <-> app.
import { $, $$, api, toast, fmt, H, META, setMeta } from './core.js';

let onImported = () => {};
export function setBankRefresh(fn) { onImported = fn; }

let BANK = { fileId: null, rows: [] };
$('#bankFile').addEventListener('change', async () => {
  const file = $('#bankFile').files[0]; if (!file) return;
  const st = $('#bankStatus'); st.className = 'status'; st.textContent = 'Se citește extrasul…';
  const fd = new FormData(); fd.append('file', file);
  try {
    const res = await api('/api/bank/parse', { method: 'POST', body: fd });
    BANK = { fileId: res.documentId, rows: res.transactions };
    st.className = 'status ok'; st.textContent = res.count + ' tranzacții găsite. Verifică și importă.';
    renderBank();
  } catch (e) { st.className = 'status err'; st.textContent = e.message; }
});
// Insigna facturii pe care o stinge linia de extras (potrivire exacta / agregata / partiala).
function matchCell(r) {
  const m = r.potrivire;
  if (!m || m.tip === 'fara' || !m.facturi || !m.facturi.length) return '<span class="muted">—</span>';
  const docs = m.facturi.map((f) => H(f.doc || 'fără nr.')).join(', ');
  if (m.tip === 'exacta') return `<span class="pill" title="Stinge exact această factură">✓ ${docs}</span>`;
  if (m.tip === 'agregata') return `<span class="pill" title="Stinge mai multe facturi vechi">${m.facturi.length} facturi: ${docs}</span>`;
  if (m.tip === 'partiala') return `<span class="pill warn" title="Plată parțială — factura rămâne parțial deschisă">parțial ${docs}</span>`;
  return '<span class="muted">—</span>';
}
function renderBank() {
  if (!BANK.rows.length) { $('#bankResult').innerHTML = '<p class="muted">Nicio tranzacție.</p>'; $('#bankImport').classList.add('hidden'); return; }
  const tipOpts = (sel) => META.types.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${t.nume}</option>`).join('');
  $('#bankResult').innerHTML = `<table><thead><tr><th><input type="checkbox" id="bankAll" checked></th><th>Data</th><th>Descriere</th>
    <th class="num">Sumă</th><th>Sens</th><th>Tip înregistrare</th><th>Partener</th><th>Factură stinsă</th></tr></thead><tbody>${
    BANK.rows.map((r, i) => `<tr>
      <td><input type="checkbox" class="bsel" data-i="${i}" checked></td>
      <td>${r.data}</td><td>${H((r.descriere || '').slice(0, 40))}</td>
      <td class="num">${fmt(r.suma)}</td><td>${r.sens === 'in' ? '↓ încasare' : '↑ plată'}</td>
      <td><select class="btip" data-i="${i}">${tipOpts(r.tip)}</select></td>
      <td><input class="bpart" data-i="${i}" value="${H(r.fields.partener || '')}" />${r.matched ? ' <span class="pill">potrivit</span>' : ''}</td>
      <td>${matchCell(r)}</td>
    </tr>`).join('')}</tbody></table>`;
  $('#bankImport').classList.remove('hidden');
  $('#bankAll').addEventListener('change', (e) => $$('.bsel').forEach((c) => { c.checked = e.target.checked; }));
  $$('.btip').forEach((s) => s.addEventListener('change', () => { BANK.rows[s.dataset.i].tip = s.value; }));
  $$('.bpart').forEach((inp) => inp.addEventListener('input', () => { BANK.rows[inp.dataset.i].fields.partener = inp.value; }));
}
$('#bankImport').addEventListener('click', async () => {
  const sel = $$('.bsel').filter((c) => c.checked).map((c) => Number(c.dataset.i));
  const transactions = sel.map((i) => ({ tip: BANK.rows[i].tip, fields: BANK.rows[i].fields, stinge: BANK.rows[i].stinge }));
  if (!transactions.length) return toast('Selectează cel puțin o tranzacție', true);
  try {
    const r = await api('/api/bank/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactions, fileId: BANK.fileId }) });
    toast(r.created + ' înregistrări create' + (r.errors.length ? ', ' + r.errors.length + ' erori' : ''));
    BANK = { fileId: null, rows: [] }; $('#bankResult').innerHTML = ''; $('#bankImport').classList.add('hidden'); $('#bankFile').value = '';
    setMeta(await api('/api/meta')); onImported();
  } catch (e) { toast(e.message, true); }
});
