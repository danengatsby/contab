'use strict';
// Registrul extraselor bancare: fisier -> extras(e) cu identitate/solduri -> tranzactii propuse
// -> punctaj -> articole postate. Nicio linie nu dispare daca utilizatorul nu o selecteaza.
import { $, $$, api, toast, fmt, H, META, setMeta } from './core.js';

let onImported = () => {};
export function setBankRefresh(fn) { onImported = fn; }

let BANK = { statements: [] };

async function loadBankRegistry() {
  const box = $('#bankRegistry'); if (!box) return;
  try {
    const payload = await api('/api/bank/statements?limit=100');
    const rows = Array.isArray(payload) ? payload : (payload.items || []);
    if (!rows.length) { box.innerHTML = '<p class="muted">Niciun extras importat pentru firma activă.</p>'; return; }
    box.innerHTML = `<table><thead><tr><th>Extras / IBAN</th><th>Interval</th><th class="num">Sold inițial</th><th class="num">Mișcări</th><th class="num">Sold final</th><th>Stare</th><th class="num">Diferență</th><th>Linii</th></tr></thead><tbody>${rows.map((s) => {
      const r = s.reconciliation || {}; const counts = r.counts || {};
      return `<tr><td><b>${H(s.statementExternalId || s.id)}</b><br><span class="muted">${H(s.iban || 'IBAN lipsă')} · ${H(s.currency || '')}</span></td>
        <td>${H(s.periodFrom || '?')} – ${H(s.periodTo || '?')}</td><td class="num">${r.openingBalance == null ? '?' : fmt(r.openingBalance)}</td>
        <td class="num">${fmt(r.movement || 0)}</td><td class="num">${r.closingBalance == null ? '?' : fmt(r.closingBalance)}</td>
        <td><span class="pill${r.ok ? '' : ' warn'}">${r.ok ? 'reconciliat' : H(r.status || 'propus')}</span></td>
        <td class="num">${fmt(r.difference || 0)}</td><td>${Number(counts.postata || 0)} postate${counts.propusa || counts.punctata ? '<br><span class="muted">' + Number((counts.propusa || 0) + (counts.punctata || 0)) + ' de rezolvat</span>' : ''}</td></tr>`;
    }).join('')}</tbody></table>${payload.total > rows.length ? '<p class="muted">Sunt afișate primele ' + rows.length + ' din ' + payload.total + ' extrase.</p>' : ''}`;
  } catch (e) { box.innerHTML = '<p class="muted">' + H(e.message) + '</p>'; }
}

const bankDetails = $('#bankFile') && $('#bankFile').closest('details');
if (bankDetails) bankDetails.addEventListener('toggle', () => { if (bankDetails.open) loadBankRegistry(); });

$('#bankFile').addEventListener('change', async () => {
  const file = $('#bankFile').files[0]; if (!file) return;
  const st = $('#bankStatus'); st.className = 'status'; st.textContent = 'Se citește și se verifică identitatea extrasului…';
  const fd = new FormData(); fd.append('file', file);
  try {
    const res = await api('/api/bank/parse', { method: 'POST', body: fd });
    BANK = { statements: res.statements || [] };
    st.className = 'status ok'; st.textContent = res.count + ' tranzacții în ' + BANK.statements.length + ' extras(e). Completează soldurile lipsă și postează.';
    renderBank(); loadBankRegistry();
  } catch (e) { st.className = 'status err'; st.textContent = e.message; }
});

function matchCell(r) {
  const m = r.potrivire || (r.proposal && r.proposal.matching);
  if (!m || m.tip === 'fara' || !m.facturi || !m.facturi.length) return '<span class="muted">—</span>';
  const docs = m.facturi.map((f) => H(f.doc || 'fără nr.')).join(', ');
  if (m.tip === 'exacta') return `<span class="pill" title="Stinge exact această factură">✓ ${docs}</span>`;
  if (m.tip === 'agregata') return `<span class="pill" title="Stinge mai multe facturi vechi">${m.facturi.length} facturi: ${docs}</span>`;
  if (m.tip === 'partiala') return `<span class="pill warn" title="Plată parțială — factura rămâne parțial deschisă">parțial ${docs}</span>`;
  return '<span class="muted">—</span>';
}

function renderBank() {
  if (!BANK.statements.length) { $('#bankResult').innerHTML = '<p class="muted">Niciun extras încărcat.</p>'; $('#bankImport').classList.add('hidden'); return; }
  const tipOpts = (sel) => META.types.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${H(t.nume)}</option>`).join('');
  $('#bankResult').innerHTML = BANK.statements.map((pack, si) => {
    const s = pack.statement; const rec = pack.reconciliation || {}; const rows = pack.transactions || [];
    return `<section class="bank-statement" data-si="${si}">
      <div class="card bank-meta">
        <h3>Extras ${H(s.statementExternalId || s.id)} · ${H(s.format || '')}</h3>
        <div class="formgrid">
          <label>IBAN<input class="bs-iban" value="${H(s.iban || '')}" placeholder="RO…" /></label>
          <label>Monedă<input class="bs-currency" value="${H(s.currency || 'RON')}" maxlength="3" /></label>
          <label>Sold inițial<input class="bs-opening" type="number" step="0.01" value="${s.openingBalance == null ? '' : s.openingBalance}" /></label>
          <label>Sold final<input class="bs-closing" type="number" step="0.01" value="${s.closingBalance == null ? '' : s.closingBalance}" /></label>
        </div>
        <p class="${rec.arithmeticOk ? 'muted' : 'error'}">Control: ${rec.openingBalance == null ? '?' : fmt(rec.openingBalance)}
          + ${fmt(rec.movement || 0)} = ${rec.closingBalance == null ? '?' : fmt(rec.closingBalance)}
          · diferență ${rec.arithmeticDifference == null ? '?' : fmt(rec.arithmeticDifference)} ${H(s.currency || '')}</p>
        <p class="muted">Fișier SHA-256: ${H((s.fileHash || '').slice(0, 16))}… · ${H(s.periodFrom || '?')} – ${H(s.periodTo || '?')}</p>
      </div>
      <div class="tablewrap"><table><thead><tr><th><input type="checkbox" class="bank-all" data-si="${si}" checked></th>
        <th>Data</th><th>Descriere / ID bancă</th><th class="num">Sumă</th><th>Sens</th><th>Stare</th>
        <th>Tip înregistrare</th><th>Partener</th><th>Curs</th><th>Factură stinsă</th></tr></thead><tbody>
        ${rows.map((r, ri) => {
          const p = r.proposal || {}; const f = p.fields || {}; const locked = r.status === 'postata' || r.status === 'exclusa';
          return `<tr data-si="${si}" data-ri="${ri}">
            <td><input type="checkbox" class="bsel" data-si="${si}" data-ri="${ri}" ${locked ? 'disabled' : 'checked'}></td>
            <td>${H(r.bookingDate || r.data || '')}</td><td>${H((r.description || r.descriere || '').slice(0, 60))}<br><small>${H(r.externalId || 'fără ID bancă')}</small></td>
            <td class="num">${fmt(r.amount == null ? r.suma : r.amount)} ${H(r.currency || s.currency || '')}</td>
            <td>${(r.direction || r.sens) === 'in' ? '↓ încasare' : '↑ plată'}</td><td><span class="pill">${H(r.status || 'propusa')}</span></td>
            <td><select class="btip" data-si="${si}" data-ri="${ri}" ${locked ? 'disabled' : ''}>${tipOpts(p.tip || r.tip)}</select></td>
            <td><input class="bpart" data-si="${si}" data-ri="${ri}" value="${H(f.partener || '')}" ${locked ? 'disabled' : ''}> ${p.matched ? '<span class="pill">potrivit</span>' : ''}</td>
            <td>${(r.currency || s.currency) !== 'RON' ? `<input class="brate" data-si="${si}" data-ri="${ri}" type="number" step="0.0001" value="${f.curs || ''}" placeholder="curs">` : '1'}</td>
            <td>${matchCell(r)}</td></tr>`;
        }).join('')}</tbody></table></div></section>`;
  }).join('');
  $('#bankImport').classList.remove('hidden');
  $$('.bank-all').forEach((c) => c.addEventListener('change', () => $$('input.bsel[data-si="' + c.dataset.si + '"]').forEach((x) => { if (!x.disabled) x.checked = c.checked; })));
  $$('.btip').forEach((x) => x.addEventListener('change', () => { BANK.statements[x.dataset.si].transactions[x.dataset.ri].proposal.tip = x.value; }));
  $$('.bpart').forEach((x) => x.addEventListener('input', () => { BANK.statements[x.dataset.si].transactions[x.dataset.ri].proposal.fields.partener = x.value; }));
  $$('.brate').forEach((x) => x.addEventListener('input', () => { BANK.statements[x.dataset.si].transactions[x.dataset.ri].proposal.fields.curs = Number(x.value) || null; }));
}

$('#bankImport').addEventListener('click', async () => {
  let total = 0;
  try {
    for (let si = 0; si < BANK.statements.length; si += 1) {
      const pack = BANK.statements[si]; const box = $('.bank-statement[data-si="' + si + '"]');
      const metadata = {
        iban: box.querySelector('.bs-iban').value.trim(), currency: box.querySelector('.bs-currency').value.trim().toUpperCase(),
        openingBalance: box.querySelector('.bs-opening').value, closingBalance: box.querySelector('.bs-closing').value,
        reason: 'Confirmare metadate extras',
      };
      const updated = await api('/api/bank/statements/' + encodeURIComponent(pack.statement.id), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata),
      });
      pack.statement = updated.statement;
      const selected = $$('input.bsel[data-si="' + si + '"]:checked').map((c) => {
        const tx = pack.transactions[Number(c.dataset.ri)]; return { id: tx.id, tip: tx.proposal.tip, fields: tx.proposal.fields, stinge: tx.proposal.stinge || [] };
      });
      if (!selected.length) continue;
      const r = await api('/api/bank/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statementId: pack.statement.id, transactions: selected }) });
      total += r.created;
    }
    if (!total) return toast('Selectează cel puțin o tranzacție; liniile nebifate rămân propuse.', true);
    toast(total + ' tranzacții postate. Liniile nebifate au rămas în registru ca propuse.');
    BANK = { statements: [] }; $('#bankResult').innerHTML = ''; $('#bankImport').classList.add('hidden'); $('#bankFile').value = '';
    setMeta(await api('/api/meta')); loadBankRegistry(); onImported();
  } catch (e) { toast(e.message, true); }
});

export { matchCell, loadBankRegistry };
