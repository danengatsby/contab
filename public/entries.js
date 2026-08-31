'use strict';

// Listele de inregistrari (recente/intrate/iesite), actiunile pe rand, documentele lipsa, arhiva.
// Extras din app.js (faza 2); apelurile inapoi spre app.js vin prin setDeps (fara cicluri).
import { $$, $, H, fmt, dataRo, toast, api, META, setMeta, confirmAction, promptAction } from './core.js';
import { pget, workMonth, lunaLabel, onPeriodChange, fillPeriods } from './periods.js';

const D = { goTab: null };
function setEntriesDeps(d) { Object.assign(D, d); }

const EFACT_TYPES = new Set(['factura_vanzare_marfuri', 'factura_vanzare_produse', 'factura_vanzare_servicii', 'livrare_intracomunitara', 'factura_storno_vanzare', 'factura_storno_cumparare']);
const SENDABLE_TYPES = new Set(['factura_vanzare_marfuri', 'factura_vanzare_produse', 'factura_vanzare_servicii', 'livrare_intracomunitara', 'factura_storno_vanzare']);
// Miscari de bunuri eligibile pentru RO e-Transport (cod UIT). Aliniat cu ELIGIBLE_TYPES din src/etransport.js.
const ETRANSP_TYPES = new Set(['aviz_livrare', 'livrare_intracomunitara', 'achizitie_intracomunitara', 'import_vamal', 'factura_vanzare_marfuri', 'factura_vanzare_produse']);
// Celula e-Transport: codul UIT (daca a fost obtinut) sau buton care deschide formularul ghidat
// (vehicul/traseu/greutati -> verifica -> trimite pentru UIT). Butonul poarta datele de prefill;
// handler-ul delegat din public/etransport.js il prinde din orice randare.
function etranspCell(e) {
  if (!ETRANSP_TYPES.has(e.tip)) return '';
  if (e.etransport && e.etransport.uit) return ` · <span class="pill" title="Cod UIT e-Transport obtinut">UIT ${H(e.etransport.uit)}</span>`;
  const nc = (e.intrastat && e.intrastat.codNC) || '';
  return ` · <button class="linkbtn ettrans" data-id="${e.id}" data-tip="${e.tip}" data-nc="${H(nc)}" data-data="${H(e.data || '')}" title="Declară transportul de bunuri și obține codul UIT (e-Transport)">e-Transport</button>`;
}
// $, $$ mutati in core.js (importate mai sus)
// Buton „arată/ascunde" pe fiecare camp de parola (login, inscriere, schimbare parola, admin…)
function entryDir(tip) {
  const t = (META.types || []).find((x) => x.id === tip);
  const grup = t ? t.grup : '';
  if (grup === 'Vanzari' || /vanzare|^livrare_intra|^bon_fiscal/.test(tip)) return 'out';
  if (grup === 'Cumparari' || /cumparare/.test(tip)) return 'in';
  return 'other';
}
// Fluxul de stare: ciorna -> validat -> aprobat -> postat. Butonul avanseaza un pas.
const NEXT_STATE = { ciorna: 'validat', validat: 'aprobat', aprobat: 'postat' };
const STATE_LABEL = { ciorna: 'ciornă', validat: 'validat', aprobat: 'aprobat', postat: 'postat' };
const NEXT_LABEL = { validat: '✓ validează', aprobat: '✓ aprobă', postat: '▶ postează' };
const BATCH_SOURCE_STATE = { validat: 'ciorna', postat: 'aprobat' };
const BATCH_ACTION_LABEL = { validat: 'Validează selectate', postat: 'Postează selectate' };

/** Loturile nu sar peste aprobarea explicită. Funcția pură ține mesajele și eligibilitatea
 * într-un singur loc, iar serverul verifică în continuare rolul, perioada și maker-checker. */
function batchTransitionError(status, target) {
  const current = status || 'postat';
  if (!BATCH_SOURCE_STATE[target]) return 'Acțiune de lot necunoscută.';
  if (current === BATCH_SOURCE_STATE[target]) return '';
  if (target === 'validat') {
    if (current === 'postat') return 'Documentul este deja postat.';
    if (current === 'aprobat') return 'Documentul este deja aprobat.';
    return 'Documentul este deja validat; aprobă-l înainte de postare.';
  }
  if (current === 'ciorna') return 'Validează și aprobă documentul înainte de postare.';
  if (current === 'validat') return 'Aprobă documentul înainte de postare.';
  return current === 'postat' ? 'Documentul este deja postat.' : 'Documentul nu poate fi postat în starea curentă.';
}
// Insigna pentru coloana "Stare": ciclul de viata + marcajele de storno.
function entryStateBadge(e) {
  if (e.stornat) return `<span class="st st-stornat" title="Corectat prin nota de storno ${H(String(e.stornoBy))}">stornat</span>`;
  if (e.stornoOf) return `<span class="st st-storno" title="Notă de stornare a articolului ${H(String(e.stornoOf))}">↩ storno</span>`;
  const st = e.status || 'postat';
  const title = st === 'postat' ? 'Postat — intră în contabilitate' : 'Ciornă — nu intră încă în contabilitate';
  return `<span class="st st-${st}" title="${title}">${STATE_LABEL[st] || st}</span>`;
}
function entryActionsHtml(e) {
  if (e.stornat || e.stornoOf) return ''; // marcajul e in coloana Stare; nicio actiune
  const st = e.status || 'postat';
  if (st !== 'postat') { // ciorna in flux: avans + stergere (nu intra in contabilitate)
    const next = NEXT_STATE[st];
    return `<button class="advst" data-id="${e.id}" data-next="${next}" title="Avansează în flux">${NEXT_LABEL[next]}</button>
      <button class="del" data-id="${e.id}" data-draft="1" title="Șterge ciorna">✕</button>`;
  }
  // postat: nu se sterge (jurnal append-only) — doar storno
  return `<button class="storno" data-id="${e.id}" title="Stornează (corecție reversibilă, fără ștergere)">↩ storno</button>`;
}
function entrySelectHtml(e) {
  const st = e.status || 'postat';
  if (e.stornat || e.stornoOf || st === 'postat') return '';
  return `<label class="entry-select-label"><input class="entry-select" type="checkbox"
    aria-label="Selectează ${H(e.tipNume || 'documentul')} ${H(e.document || e.id)}" /></label>`;
}
function entryRowHtml(e) {
  const formula = e.lines.map((l) => `${l.debit}=${l.credit}`).join(', ');
  const total = e.lines.reduce((s, l) => s + l.suma, 0);
  const draft = e.status && e.status !== 'postat';
  return `<tr class="${e.system ? 'sys' : ''}${draft ? ' draft' : ''}" data-entry-id="${H(e.id)}" data-entry-status="${H(e.status || 'postat')}">
    <td class="entry-select-cell adv">${entrySelectHtml(e)}</td>
    <td>${H(e.data)}</td>
    <td>${H(e.tipNume)}${e.system ? ' <span class="pill">auto</span>' : ''}</td>
    <td>${H(e.partener)}</td>
    <td class="acc adv">${H(formula)}</td>
    <td class="num">${fmt(total)}</td>
    <td>${entryStateBadge(e)}</td>
    <td><a class="linkbtn" href="/pdf/note/${e.id}" target="_blank">PDF</a>
        ${e.lines.some((l) => /^531/.test(String(l.debit))) ? ` · <a class="linkbtn" href="/pdf/chitanta/${e.id}" target="_blank" title="Chitanta pentru incasarea in numerar (numar din seria CH)">chitanță</a>` : ''}
        ${EFACT_TYPES.has(e.tip) ? ` · <a class="linkbtn" href="/xml/efactura/${e.id}" target="_blank">e-Factura</a>` : ''}${etranspCell(e)}
        ${SENDABLE_TYPES.has(e.tip) ? (e.spv
    ? ` · <button class="linkbtn spvstat" data-id="${e.id}">SPV: ${e.spv.stare}${e.spv.acceptat ? ' ✓' : ''}</button>${e.spv.idDescarcare ? ` · <button class="linkbtn spvdl" data-id="${e.id}">recipisă</button>` : ''}`
    : ` · <button class="linkbtn spvsend" data-id="${e.id}">trimite SPV</button>`) : ''}
        ${e.fileId ? ` · <a class="linkbtn" href="/api/document/${e.fileId}/file" target="_blank">doc</a>` : ''}</td>
    <td>${entryActionsHtml(e)}</td>
  </tr>`;
}
// Coloana „Formula" (6811=281) e cel mai tehnic lucru de pe prima pagina pe care o deschide un
// incepator; clasa `adv` o scoate in modul simplu. O poarta si antetul, si celula din
// entryRowHtml — altfel ar ramane o coloana fara cap.
function renderEntryTable(containerId, rowsHtml, emptyMsg) {
  const el = $('#' + containerId); if (!el) return;
  if (!rowsHtml) { el.innerHTML = `<p class="muted">${emptyMsg}</p>`; return; }
  el.innerHTML = `<div class="entry-batchbar adv" role="region" aria-label="Acțiuni pentru documentele selectate">
      <span class="entry-batch-selection"><b class="entry-selected-count">0 selectate</b><span class="muted">din această listă</span></span>
      <div class="entry-batch-actions">
        <button type="button" class="btn small entry-batch-validate" disabled>✓ Validează selectate</button>
        <button type="button" class="btn small primary entry-batch-post" disabled title="Scurtătură: Ctrl/⌘ + Enter">▶ Postează selectate</button>
        <button type="button" class="btn small ghost entry-next-error" disabled title="Scurtătură: F8">Următoarea eroare</button>
      </div>
      <span class="entry-batch-status muted" role="status" aria-live="polite"></span>
    </div>
    <table><thead><tr>
    <th class="entry-select-cell adv"><label class="entry-select-label"><input class="entry-select-all" type="checkbox" aria-label="Selectează toate documentele nepostate din listă" /></label></th>
    <th>Data</th><th>Tip</th><th>Partener</th><th class="adv">Formulă</th><th class="num">Sumă</th><th>Stare</th><th>Fișiere</th><th></th>
    </tr></thead><tbody>${rowsHtml}</tbody></table>`;
  bindEntryActions(el);
}

function selectedEntryRows(root) {
  return Array.from(root.querySelectorAll('tbody .entry-select:checked')).map((box) => box.closest('tr')).filter(Boolean);
}
function updateEntryBatchBar(root) {
  const rows = selectedEntryRows(root);
  const count = root.querySelector('.entry-selected-count');
  if (count) count.textContent = rows.length + (rows.length === 1 ? ' selectat' : ' selectate');
  root.querySelectorAll('.entry-batch-validate, .entry-batch-post').forEach((b) => { b.disabled = rows.length === 0; });
  const all = root.querySelector('.entry-select-all');
  const boxes = Array.from(root.querySelectorAll('tbody .entry-select'));
  if (all) {
    all.checked = boxes.length > 0 && boxes.every((box) => box.checked);
    all.indeterminate = boxes.some((box) => box.checked) && !all.checked;
  }
}

function entryErrorRows(scope) {
  return Array.from((scope || document).querySelectorAll('.entry-batch-error'));
}
function focusNextBatchError(root) {
  const rows = entryErrorRows(root);
  if (!rows.length) return false;
  const current = rows.findIndex((row) => row.classList.contains('entry-batch-error-current'));
  rows.forEach((row) => row.classList.remove('entry-batch-error-current'));
  const next = rows[(current + 1) % rows.length];
  next.classList.add('entry-batch-error-current');
  next.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  next.focus({ preventScroll: true });
  return true;
}

function markBatchErrors(root, errors) {
  errors.forEach((failure, index) => {
    const row = Array.from(root.querySelectorAll('tbody tr[data-entry-id]'))
      .find((candidate) => candidate.dataset.entryId === String(failure.id));
    if (!row) return;
    row.classList.add('entry-batch-error');
    row.tabIndex = -1;
    const message = document.createElement('span');
    message.className = 'entry-batch-error-message';
    message.id = root.id + '-batch-error-' + index;
    message.textContent = failure.message;
    message.setAttribute('role', 'alert');
    const actionCell = row.lastElementChild;
    if (actionCell) actionCell.appendChild(message);
    row.setAttribute('aria-describedby', message.id);
    const box = row.querySelector('.entry-select');
    if (box) box.checked = true;
  });
  const next = root.querySelector('.entry-next-error');
  if (next) next.disabled = errors.length === 0;
  updateEntryBatchBar(root);
}

async function advanceEntryStatus(id, target) {
  return api('/api/entries/' + id + '/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: target }),
  });
}
async function refreshEntryLists() {
  setMeta(await api('/api/meta'));
  fillPeriods();
  await loadEntries();
}
async function mapWithConcurrency(items, worker, limit = 4) {
  const results = new Array(items.length); let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor; cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

async function runEntryBatch(root, target) {
  const rows = selectedEntryRows(root);
  if (!rows.length) return;
  if (target === 'postat') {
    const approved = rows.filter((row) => !batchTransitionError(row.dataset.entryStatus, target)).length;
    if (approved && !await confirmAction(
      `${approved} ${approved === 1 ? 'document aprobat va fi postat' : 'documente aprobate vor fi postate'} și vor intra în contabilitate. Documentele din alte stări vor fi raportate separat.`,
      { title: 'Postezi documentele selectate?', confirmLabel: approved === 1 ? 'Postează documentul' : 'Postează ' + approved + ' documente' }
    )) return;
  }
  const bar = root.querySelector('.entry-batchbar');
  const status = root.querySelector('.entry-batch-status');
  const controls = Array.from(root.querySelectorAll('.entry-batchbar button, .entry-select, .entry-select-all'));
  controls.forEach((control) => { control.disabled = true; });
  if (bar) bar.setAttribute('aria-busy', 'true');
  let complete = 0;
  if (status) status.textContent = `Se procesează 0/${rows.length}…`;
  const results = await mapWithConcurrency(rows, async (row) => {
    const id = row.dataset.entryId;
    const localError = batchTransitionError(row.dataset.entryStatus, target);
    if (localError) { complete += 1; if (status) status.textContent = `Se procesează ${complete}/${rows.length}…`; return { id, message: localError }; }
    try {
      await advanceEntryStatus(id, target);
      complete += 1; if (status) status.textContent = `Se procesează ${complete}/${rows.length}…`;
      return { id, ok: true };
    } catch (error) {
      complete += 1; if (status) status.textContent = `Se procesează ${complete}/${rows.length}…`;
      return { id, message: error.message || 'Operațiunea nu a putut fi finalizată.' };
    }
  });
  const errors = results.filter((result) => !result.ok);
  const succeeded = results.length - errors.length;
  try {
    await refreshEntryLists();
    const freshRoot = $('#' + root.id);
    const freshStatus = freshRoot && freshRoot.querySelector('.entry-batch-status');
    if (freshRoot) markBatchErrors(freshRoot, errors);
    if (freshStatus) freshStatus.textContent = errors.length
      ? `${succeeded} finalizate · ${errors.length} cu eroare` : `${succeeded} ${target === 'postat' ? 'postate' : 'validate'}`;
    toast(errors.length
      ? `${BATCH_ACTION_LABEL[target]}: ${succeeded} finalizate, ${errors.length} cu eroare. Folosește „Următoarea eroare”.`
      : `${succeeded} ${succeeded === 1 ? 'document finalizat' : 'documente finalizate'} în lot.`, errors.length > 0);
  } catch (error) {
    if (bar) bar.removeAttribute('aria-busy');
    controls.forEach((control) => { control.disabled = false; });
    updateEntryBatchBar(root);
    toast('Lotul a fost procesat, dar lista nu s-a putut reîncărca: ' + error.message, true);
  }
}

function bindEntryActions(root) {
  const all = root.querySelector('.entry-select-all');
  if (all) all.addEventListener('change', () => {
    root.querySelectorAll('tbody .entry-select').forEach((box) => { box.checked = all.checked; });
    updateEntryBatchBar(root);
  });
  root.querySelectorAll('tbody .entry-select').forEach((box) => box.addEventListener('change', () => updateEntryBatchBar(root)));
  const validate = root.querySelector('.entry-batch-validate');
  if (validate) validate.addEventListener('click', () => runEntryBatch(root, 'validat'));
  const post = root.querySelector('.entry-batch-post');
  if (post) post.addEventListener('click', () => runEntryBatch(root, 'postat'));
  const nextError = root.querySelector('.entry-next-error');
  if (nextError) nextError.addEventListener('click', () => focusNextBatchError(root));
  root.querySelectorAll('.del').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmAction(b.dataset.draft ? 'Ciorna va fi eliminată definitiv.' : 'Înregistrarea va fi eliminată definitiv.', {
      title: b.dataset.draft ? 'Ștergi ciorna?' : 'Ștergi înregistrarea?', confirmLabel: 'Șterge', danger: true,
    })) return;
    try {
      await api('/api/entries/' + b.dataset.id, { method: 'DELETE' });
      toast('Înregistrare ștearsă');
      setMeta(await api('/api/meta')); fillPeriods(); loadEntries();
    } catch (e) { toast(e.message, true); }
  }));
  root.querySelectorAll('.advst').forEach((b) => b.addEventListener('click', async () => {
    const next = b.dataset.next;
    try {
      await advanceEntryStatus(b.dataset.id, next);
      toast(next === 'postat' ? 'Articol postat (intră în contabilitate)' : 'Ciornă avansată: ' + next);
      await refreshEntryLists();
    } catch (e) { toast(e.message, true); }
  }));
  root.querySelectorAll('.storno').forEach((b) => b.addEventListener('click', async () => {
    const data = await promptAction('Storno este o corecție reversibilă și păstrează istoricul articolului original.', {
      title: 'Înregistrează nota de storno', label: 'Data notei', inputType: 'date',
      value: new Date().toISOString().slice(0, 10), required: true,
      pattern: /^\d{4}-\d{2}-\d{2}$/, patternMessage: 'Folosește formatul AAAA-LL-ZZ.', confirmLabel: 'Înregistrează storno',
    });
    if (data == null) return;
    try {
      await api('/api/entries/' + b.dataset.id + '/storno', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
      toast('Articol stornat (corecție reversibilă înregistrată)');
      setMeta(await api('/api/meta')); fillPeriods(); loadEntries();
    } catch (e) { toast(e.message, true); }
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

function visibleElement(element) {
  return !!element && !element.hidden && !element.classList.contains('hidden')
    && (!element.getClientRects || element.getClientRects().length > 0);
}
function visibleEntryForm() {
  const form = $('#entryForm');
  return visibleElement(form) ? form : null;
}
function activeBatchRoot() {
  const focused = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest('.tablewrap') : null;
  if (focused && focused.querySelector('.entry-batchbar') && selectedEntryRows(focused).length) return focused;
  const scope = document.querySelector('.tab.active') || document;
  return Array.from(scope.querySelectorAll('.tablewrap')).find((root) =>
    visibleElement(root) && root.querySelector('.entry-batchbar') && selectedEntryRows(root).length) || null;
}
function focusNextVisibleError() {
  const scope = document.querySelector('.tab.active') || document;
  const batchRoot = activeBatchRoot();
  if (batchRoot && focusNextBatchError(batchRoot)) return true;
  const candidates = Array.from(scope.querySelectorAll(
    'input:invalid, select:invalid, textarea:invalid, [aria-invalid="true"], .entry-batch-error'
  )).filter(visibleElement);
  if (!candidates.length) return false;
  const active = document.activeElement;
  const current = candidates.findIndex((candidate) => candidate === active || candidate.contains(active));
  const next = candidates[(current + 1) % candidates.length];
  if (!next.hasAttribute('tabindex') && !/^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(next.tagName)) next.tabIndex = -1;
  next.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  next.focus({ preventScroll: true });
  return true;
}

// Comenzi expert, deliberat inactive în modul simplu. `click`/`requestSubmit` păstrează aceleași
// handlere ca butoanele vizibile: scurtătura nu creează o cale paralelă de salvare sau postare.
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || document.body.classList.contains('simple-ui')) return;
  if (document.querySelector('dialog.app-dialog[open], .login-overlay:not(.hidden)')) return;
  const key = String(event.key || '').toLowerCase();
  if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && key === 'f') {
    const search = $('#companyPickerSearchButton'); const company = $('#firmaSelect');
    if (!search && !company) return;
    event.preventDefault();
    if (search && !search.classList.contains('hidden')) search.click();
    else if (company) company.focus();
    return;
  }
  if (event.key === 'F8' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    if (!focusNextVisibleError()) toast('Nu există erori vizibile în ecranul curent.');
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 's') {
    const form = visibleEntryForm(); const save = $('#saveDraft');
    if (!form || !save || save.disabled) return;
    event.preventDefault();
    save.click();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === 'Enter') {
    const form = visibleEntryForm(); const submit = $('#postEntry');
    if (form && submit && !submit.disabled) {
      event.preventDefault(); form.requestSubmit(submit); return;
    }
    const root = activeBatchRoot(); const post = root && root.querySelector('.entry-batch-post');
    if (post && !post.disabled) { event.preventDefault(); post.click(); }
  }
});
// Cache PE PERIOADA SELECTATA (luna sau an): la volume mari, „toate inregistrarile" inseamna
// zeci de MB pe fiecare schimbare de tab (masurat: 19MB la 50k; luna curenta = 1.7MB). Se cere
// de la server exact perioada fiecarui filtru (?period=YYYY-MM sau YYYY); implicit = luna de lucru.
let ENTRIES_CACHE = {}; // cheie de perioada -> lista sortata a perioadei
function inPeriodClient(e, period) {
  if (!period) return true;
  return (e.period || (e.data || '').slice(0, 7)).startsWith(period);
}
function periodKey(prefix) {
  const p = pget(prefix);
  return /^\d{4}(-\d{2})?$/.test(p) ? p : String(new Date().getFullYear());
}
function periodKeys() { return [...new Set(['intrate', 'iesite', 'toate'].map(periodKey))]; }
async function loadEntries() {
  const ks = periodKeys();
  const got = await Promise.all(ks.map((k) => api('/api/entries?period=' + k)));
  ENTRIES_CACHE = {};
  ks.forEach((k, i) => { ENTRIES_CACHE[k] = got[i]; });
  renderEntryLists();
}
function renderEntryLists() {
  // o perioada nou-selectata, absenta din cache -> refetch (loadEntries re-randeaza la final)
  if (periodKeys().some((k) => !ENTRIES_CACHE[k])) { loadEntries(); return; }
  const orderedFor = (prefix) => (ENTRIES_CACHE[periodKey(prefix)] || []).slice().reverse();
  const ordered = orderedFor('toate');
  // 📥 intrate (filtrate pe Lună+An)
  const pi = pget('intrate');
  let intr = orderedFor('intrate').filter((e) => entryDir(e.tip) === 'in');
  if (pi) intr = intr.filter((e) => inPeriodClient(e, pi));
  if ($('#countIntrare')) $('#countIntrare').textContent = intr.length + ' documente';
  renderEntryTable('entriesIntrare', intr.map(entryRowHtml).join(''), 'Niciun document de intrare în perioada aleasă.');
  // 📤 ieșite
  const po = pget('iesite');
  let ies = orderedFor('iesite').filter((e) => entryDir(e.tip) === 'out');
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
  el.innerHTML = `<div class="notice ${alert ? 'warning' : 'success'}">
    <span class="notice-icon">${alert ? '⚠️' : '✅'}</span>
    <div><b>${lbl}:</b> ${d.countThis} documente intrate · media ultimelor 3 luni: <b>${d.avgPrev}</b>${d.countThis < d.avgPrev ? ' <span class="muted">(sub medie — verifică ce lipsește)</span>' : ''}
      ${d.missing.length
    ? `<div data-u="u23"><b>Posibil lipsă</b> — furnizori care apăreau lunar, dar fără document în ${lbl}:</div>
           <ul class="checklist todo" data-u="u27">${d.missing.map((m) => `<li>${H(m.partener)} <span class="muted">— ultima oară: ${lunaLabel(m.ultimaLuna)} · ${m.luniPrezent}/3 luni anterioare</span></li>`).join('')}</ul>`
    : '<div data-u="u18">✓ Nu pare să lipsească niciun document recurent.</div>'}
    </div></div>`;
}

function archiveSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
  return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

/** Matricea anexelor situațiilor financiare. Backendul stabilește aplicabilitatea și verifică
 * octeții; interfața nu deduce obligații juridice din numele fișierului sau din categorie. */
export function annualFilingMatrixHtml(filing, year) {
  const state = filing || {};
  if (!state.rows) return `<div class="notice warning"><span class="notice-icon">⚠️</span><div>
    Matricea anexelor legale pentru ${H(year)} nu este disponibilă.</div></div>`;
  const blockers = (state.blockers || []).length
    ? `<div class="notice warning annual-filing-blockers"><span class="notice-icon">⚠️</span><div><b>Sigilare blocată</b><ul>${state.blockers.map((x) => `<li>${H(x)}</li>`).join('')}</ul></div></div>`
    : '<div class="notice success annual-filing-ready"><span class="notice-icon">✅</span><div><b>Matrice completă.</b> Toate probele obligatorii sunt aprobate și se regăsesc în ZIP-ul exact transmis.</div></div>';
  const rows = state.rows.map((row) => {
    const e = row.evidence; let status;
    if (!row.required && !e) status = '<span class="st">nu se aplică</span>';
    else if (row.complete) status = '<span class="st st-postat">complet</span>';
    else status = `<span class="st st-stornat" title="${H(row.reason || 'Probă incompletă')}">incomplet</span>`;
    const evidence = e ? `<a class="linkbtn" href="/api/document/${encodeURIComponent(e.documentId)}/file" target="_blank">${H(e.fileName)}</a>
      <div class="muted">rev. ${H(e.revision)} · ${H(archiveSize(e.bytes))}${e.filingBinding ? ` · depunerea ${H(e.filingBinding.ordinal)}${e.filingBinding.receiptReference ? ' · recipisa ' + H(e.filingBinding.receiptReference) : ''}` : ''}</div><code class="annual-archive-hash">${H(e.sha256)}</code>` : '<span class="muted">—</span>';
    const signature = !row.signatureRequired ? '<span class="muted">nu se aplică fișierului ZIP</span>'
      : e && e.signature ? `${H(e.signature.signedBy)}<div class="muted">${H(e.signature.signedAt)} · ${H(e.signature.type)}</div>`
        : '<span class="muted">lipsește declarația semnăturii</span>';
    const approval = e && e.approval
      ? `${H(e.approval.approvedByName || '—')}<div class="muted">${H(String(e.approval.approvedAt || '').replace('T', ' ').slice(0, 16))} UTC</div>`
      : e ? `<button class="btn small approve-annual-evidence" data-id="${H(e.documentId)}">✓ Aprobă hash-ul</button>` : '<span class="muted">—</span>';
    const packageState = row.requiredInZip ? (row.inSubmittedZip
      ? '<span class="st st-postat">hash găsit</span>' : '<span class="st st-stornat">hash absent</span>') : '<span class="muted">probă internă / pachet</span>';
    return `<tr><td><b>${H(row.label)}</b><div class="muted">${H(row.basis)}</div></td><td>${row.required ? 'obligatoriu' : 'după caz'}</td>
      <td>${evidence}</td><td>${signature}</td><td>${approval}</td><td>${packageState}</td><td>${status}</td></tr>`;
  }).join('');
  const ctx = state.context || {};
  const context = ctx.type === 'pfa' ? 'PFA — matricea situațiilor financiare ale societăților nu se aplică.'
    : `Categorie: ${ctx.category || 'neconfirmată'} · audit: ${ctx.auditReason || 'nedeterminat'}`;
  const legal = (state.legalBasis || []).map((source) => `<a href="${H(source.url)}" target="_blank" rel="noopener">${H(source.title)}</a>`).join(' · ');
  const upload = ctx.type === 'pfa' ? '' : `<form id="annualEvidenceForm" class="inlineform annual-evidence-form">
    <label>Anexă <select name="kind">${state.rows.map((row) => `<option value="${H(row.kind)}" data-signature="${row.signatureRequired ? '1' : '0'}">${H(row.label)}</option>`).join('')}</select></label>
    <label>Semnat de <input name="signedBy" placeholder="nume / funcție" /></label>
    <label>Data semnării <input name="signedAt" type="date" /></label>
    <label>Forma semnăturii <select name="signatureType"><option value="handwritten_scan">olografă scanată</option><option value="qualified_electronic">electronică calificată</option><option value="advanced_electronic">electronică avansată</option></select></label>
    <label>Fișier exact <input name="file" type="file" accept="application/pdf,.pdf" required /></label>
    <button class="btn small" type="submit">Încarcă revizie</button>
  </form><p class="muted">Semnatarul și forma semnăturii sunt declarații ale operatorului; aplicația verifică hash-ul și aprobarea, nu certificatul criptografic din PDF.</p>`;
  return `<div class="annual-filing-matrix">${blockers}<p class="muted">${H(context)}${legal ? ' · ' + legal : ''}</p>
    <div class="tablewrap"><table><thead><tr><th>Document / temei</th><th>Cerință</th><th>Fișier exact și SHA-256</th><th>Semnături declarate</th><th>Aprobare pe hash</th><th>În ZIP transmis</th><th>Stare</th></tr></thead><tbody>${rows}</tbody></table></div>${upload}</div>`;
}

/** Istoricul permanent al dosarului anual. Funcție pură: serverul decide integritatea,
 * interfața afișează fiecare versiune și descarcă explicit octeții acelei versiuni. */
export function annualArchiveVersionsHtml(status, year) {
  const state = status || {}; const versions = (state.versions || []).slice()
    .sort((a, b) => Number(b.version) - Number(a.version));
  const open = state.closed ? '' : `<div class="notice warning annual-archive-state"><span class="notice-icon">⚠️</span><div>
    Exercițiul ${H(year)} este încă deschis. Dosarul poate fi sigilat numai după finalizarea închiderii anuale.</div></div>`;
  if (!versions.length) return open + `<p class="muted annual-archive-empty">Nicio versiune sigilată pentru ${H(year)}.</p>`;
  const rows = versions.map((v) => {
    const verified = v.verified === true;
    const created = dataRo(v.createdAt) + (String(v.createdAt || '').match(/T(\d{2}:\d{2})/) ? ' · ' + String(v.createdAt).match(/T(\d{2}:\d{2})/)[1] + ' UTC' : '');
    const check = verified
      ? '<span class="st st-postat">integritate verificată</span>'
      : `<span class="st st-stornat" title="${H(v.verificationError || 'Verificarea integrității a eșuat')}">integritate eșuată</span>`;
    const href = '/api/dosar-anual?year=' + encodeURIComponent(year) + '&version=' + encodeURIComponent(v.version);
    return `<tr><td><b>v${H(v.version)}</b></td><td>${H(created)}${v.createdByName ? `<div class="muted">${H(v.createdByName)}</div>` : ''}</td>
      <td>${H(v.reason || '—')}</td><td>${H(archiveSize(v.bytes))}</td><td>${check}</td>
      <td><code class="annual-archive-hash">${H(v.zipSha256 || '—')}</code></td>
      <td>${verified ? `<a class="btn small" href="${H(href)}">📦 Descarcă v${H(v.version)}</a>` : '<span class="muted">Descărcare blocată</span>'}</td></tr>`;
  }).join('');
  return open + `<div class="tablewrap annual-archive-versions"><table><thead><tr><th>Versiune</th><th>Sigilată</th><th>Motiv</th>
    <th>Dimensiune</th><th>Stare</th><th>SHA-256 ZIP</th><th>Fișier exact</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function loadArhiva() {
  const p = pget('arhiva') || workMonth();
  const monthly = /^\d{4}-\d{2}$/.test(p);
  const yr = p.slice(0, 4);
  const pq = '?period=' + p; const yq = '?year=' + yr;
  const [all, payroll, annualStatus] = await Promise.all([
    api('/api/entries'),
    monthly ? api('/api/stat-plata?period=' + encodeURIComponent(p)) : Promise.resolve(null),
    api('/api/dosar-anual/status?year=' + encodeURIComponent(yr)),
  ]);
  const payrollPosted = !!(payroll && payroll.postat);
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
  const d112Monthly = payrollPosted
    ? L('/pdf/d112' + pq, '⬇ D112 PDF') + L('/xml/d112' + pq, 'D112 XML')
    : '<span class="muted">D112 indisponibilă — postează statul de plată.</span>';
  const declMonthly = L('/pdf/d300' + pq, '⬇ D300 PDF') + L('/xml/d300' + pq, 'D300 XML') + L('/xml/d301' + pq, 'D301 XML (TVA specială)') + L('/xml/d307' + pq, 'D307 XML (ajustări TVA)') + L('/xml/d311' + pq, 'D311 XML (cod TVA anulat)') + L('/xml/d394' + pq, 'D394 XML') + L('/xml/d390' + pq, 'D390 XML (VIES)') + L('/xml/d100' + pq, 'D100 XML (trim.)') + L('/csv/intrastat' + pq, 'Intrastat CSV') + L('/xml/intrastat' + pq, 'Intrastat centralizator XML') + d112Monthly + L('/xml/d205' + yq, 'D205 XML (an)') + L('/xml/d101' + yq, 'D101 XML (an)') + L('/xml/d107' + yq, 'D107 XML (sponsorizări)') + L('/xml/saft' + yq, 'SAF-T XML');
  $('#arhivaView').innerHTML = `
    <div class="card"><h3>📥 01 · Intrări (facturi primite)</h3>
      <p class="muted">Facturi de la furnizori, bonuri, chitanțe — cu fișierul scanat atașat.</p>${tbl(intr, etranspCell, 'Niciun document de intrare în perioadă.')}</div>
    <div class="card"><h3>📤 02 · Ieșiri (facturi emise)</h3>
      <p class="muted">Facturi către clienți — cu PDF, e-Factura și e-Transport.</p>${tbl(ies, (e) => eFact(e) + etranspCell(e), 'Niciun document de ieșire în perioadă.')}</div>
    <div class="grid2">
      <div class="card"><h3>🏦 03 · Bancă</h3><p class="muted">Jurnalul de bancă (5121) și extrasele importate.</p>${G('cashbook', 'Deschide Bancă / Casă')}</div>
      <div class="card"><h3>💵 04 · Casă</h3><p class="muted">Registrul de casă (5311) — încasări/plăți în numerar.</p>${G('cashbook', 'Deschide Bancă / Casă')}</div>
    </div>
    <div class="card"><h3>👥 05 · Salarii</h3>
      <p class="muted">State de plată și declarația D112.</p>${monthly
    ? (payrollPosted ? L('/pdf/stat-plata' + pq, '⬇ Stat de plată PDF') + L('/xml/d112' + pq, 'D112 XML')
      : G('salarizare', 'Deschide și postează statul de plată'))
    : '<span class="muted">Alege o lună pentru statul de plată.</span>'}</div>
    <div class="card"><h3>🧾 06 · Declarații ANAF</h3>
      <p class="muted">Declarațiile fiscale ale perioadei.${monthly ? '' : ' <b>Alege o lună</b> pentru declarațiile lunare (D300/D394/D112).'}</p>${monthly ? declMonthly : L('/xml/saft' + yq, 'SAF-T XML (an întreg)')}
      ${monthly ? `<div data-u="u23"><button id="validateDecl" class="btn small" data-p="${p}" data-yr="${yr}">🔍 Verifică declarațiile (pre-depunere)</button><div id="validateResult" data-u="u18"></div></div>` : ''}
      <p class="muted" data-u="u28">⚠️ Ciorne — verificarea de mai sus prinde erorile frecvente, dar validează final cu <b>DUKIntegrator</b> / XSD ANAF înainte de depunere.</p></div>
    <div class="card"><h3>📚 07 · Registre & Bilanț</h3>
      <p class="muted">Registrele obligatorii și situațiile financiare.</p>
      ${L('/pdf/journal' + pq, '⬇ Registru-jurnal PDF')}${L('/csv/journal' + pq, 'Jurnal CSV')}${L('/pdf/ledger' + pq, '⬇ Cartea mare PDF')}${L('/pdf/balance' + pq, '⬇ Balanță PDF')}${L('/csv/balance' + pq, 'Balanță CSV')}${L('/pdf/pl' + yq, '⬇ Cont P&P PDF')}${L('/pdf/bilant' + pq, '⬇ Bilanț PDF')}
      <hr class="soft" data-u="u18"><p class="muted" data-u="u18">Dosarul anual este un ZIP persistent, sigilat după finalizarea cockpitului: documente justificative și extrase originale, state, stoc, aprobări, declarațiile și recipisele exacte. Descărcarea verifică manifestul semnat și nu regenerează rapoartele.</p>
      <h4>Completitudinea anexelor situațiilor financiare</h4>
      ${annualFilingMatrixHtml(annualStatus.filing, yr)}
      <button id="sealAnnualArchive" class="btn small" data-year="${H(yr)}"${annualStatus.closed && annualStatus.filing && annualStatus.filing.ready ? '' : ' disabled'}>🔏 ${(annualStatus.versions || []).length ? 'Creează versiune nouă' : 'Sigilează prima versiune'}</button>
      <div id="annualArchiveVersions">${annualArchiveVersionsHtml(annualStatus, yr)}</div></div>`;
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
  const seal = $('#sealAnnualArchive');
  const evidenceForm = $('#annualEvidenceForm');
  if (evidenceForm) {
    const adaptEvidenceForm = () => {
      const option = evidenceForm.kind.options[evidenceForm.kind.selectedIndex];
      const signed = option && option.dataset.signature === '1';
      for (const name of ['signedBy', 'signedAt', 'signatureType']) {
        evidenceForm[name].disabled = !signed; evidenceForm[name].required = signed;
      }
      evidenceForm.file.accept = evidenceForm.kind.value === 'submitted_zip'
        ? 'application/zip,.zip' : 'application/pdf,.pdf';
    };
    evidenceForm.kind.addEventListener('change', adaptEvidenceForm); adaptEvidenceForm();
    evidenceForm.addEventListener('submit', async (event) => {
      event.preventDefault(); const button = evidenceForm.querySelector('button[type="submit"]'); button.disabled = true;
      try {
        const fd = new FormData(evidenceForm); fd.append('year', yr);
        await api('/api/dosar-anual/evidence', { method: 'POST', body: fd });
        toast('Anexa a fost amprentată. Verifică fișierul și aprobă hash-ul înainte de sigilare.');
        await loadArhiva();
      } catch (e) { toast(e.message, true); } finally { button.disabled = false; }
    });
  }
  $$('#arhivaView .approve-annual-evidence').forEach((button) => button.addEventListener('click', async () => {
    const yes = await confirmAction('Aprobarea este legată de SHA-256 al fișierului. O revizie ulterioară va necesita o aprobare nouă.', {
      title: 'Aprobi anexa exactă?', confirmLabel: 'Aprobă hash-ul', danger: false,
    });
    if (!yes) return;
    button.disabled = true;
    try {
      await api('/api/dosar-anual/evidence/' + encodeURIComponent(button.dataset.id) + '/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
      });
      toast('Anexa a fost aprobată pe hash.'); await loadArhiva();
    } catch (e) { toast(e.message, true); } finally { button.disabled = false; }
  }));
  if (seal) seal.addEventListener('click', async () => {
    seal.disabled = true;
    try {
      const body = {};
      if ((annualStatus.versions || []).length) {
        const reason = await promptAction('Versiunea existentă rămâne imuabilă. Pentru o rectificativă se creează o versiune nouă, cu motiv.', {
          title: 'Versiune nouă a dosarului anual', label: 'Motivul versiunii noi', required: true,
          minLength: 10, multiline: true, confirmLabel: 'Sigilează versiunea nouă',
        });
        if (reason == null) return;
        body.newRevision = true; body.reason = reason;
      } else {
        const yes = await confirmAction('Sigilarea este posibilă numai după închidere, depunere, repartizare și atașarea recipiselor. ZIP-ul rezultat nu se mai modifică.', {
          title: 'Sigilezi dosarul anual?', confirmLabel: 'Sigilează', danger: false,
        });
        if (!yes) return;
      }
      const result = await api('/api/dosar-anual/seal?year=' + encodeURIComponent(seal.dataset.year), {
        method: 'POST', body: JSON.stringify(body),
      });
      toast('Dosar anual sigilat: versiunea ' + result.version + ' · SHA-256 ' + result.zipSha256.slice(0, 12) + '…');
      await loadArhiva();
    } catch (e) { toast(e.message, true); } finally { seal.disabled = !annualStatus.closed || !(annualStatus.filing && annualStatus.filing.ready); }
  });
}
onPeriodChange('arhiva', loadArhiva);

/** Raportul de calitate a citirii automate — tabelele pe furnizori / formate / controale.
 *  Funcție pură (testată în test/frontend.mjs): primește raportul, întoarce HTML. */
export function calitateRaportHtml(r) {
  if (!r) return '';
  if (!r.documenteCitite) return '<p class="muted">Niciun document citit automat în perioada aleasă.</p>';
  const tabel = (titlu, rows, etCheie) => (rows || []).length
    ? `<h3>${H(titlu)}</h3><table><thead><tr><th>${H(etCheie)}</th><th class="num">Corecții</th><th class="num">Câmpuri</th><th>Ce pică cel mai des</th></tr></thead><tbody>${
      rows.slice(0, 10).map((g) => `<tr><td>${H(g.cheie)}</td><td class="num">${H(g.interventii)}</td><td class="num">${H(g.campuri)}</td>
        <td class="muted">${H((g.controaleTop || []).slice(0, 3).map((c) => c.cod + ' ×' + c.n).join(', ') || '—')}</td></tr>`).join('')}</tbody></table>`
    : '';
  // aceeasi structura de card ca pe dashboard (.kpi > .lbl/.val/.sub), ca sa arate la fel
  const kpiCard = (lbl, val, sub) => `<div class="kpi"><div class="lbl">${H(lbl)}</div><div class="val">${H(val)}</div><div class="sub">${H(sub || '')}</div></div>`;
  const kpi = `<div class="kpis">${
    kpiCard('Documente citite', r.documenteCitite, 'în ultimele ' + (r.zile || '—') + ' zile')
    + kpiCard('Scor diagnostic mediu', r.scorMediu == null ? '—' : r.scorMediu + '%', 'nu este dovadă fiscală')
    + kpiCard('Acceptate de politica de risc', r.eligibileAutomat == null ? r.postateAutomat : r.eligibileAutomat, 'pot primi numai o ciornă')
    + kpiCard('Rată de corecție', r.rataCorectie + '%', 'din documentele revizuite')}</div>`;
  const stare = (r.autoDraftActiv == null ? r.autoPostActiv : r.autoDraftActiv)
    ? '<p class="muted">Pregătirea automată e <b>pornită</b>: controalele deterministe și politica calibrată pot crea numai o ciornă; un om o verifică înainte de postare.</p>'
    : '<p class="muted">Pregătirea automată e <b>oprită</b> (implicit). Se poate porni din Setări → datele firmei; nu postează niciodată fără verificare umană.</p>';
  // CINE a citit documentele. Increderea ramane diagnostic; politica foloseste numai performanta
  // observata a benzii pe documente reale revizuite.
  const modele = (r.modele || []).length
    ? `<h3>Cine a citit documentele</h3><table><thead><tr><th>Extractor</th><th class="num">Documente</th><th class="num">Încredere medie</th><th class="num">Acceptate de politica de risc</th></tr></thead><tbody>${
      r.modele.map((m) => `<tr><td>${H(m.model || 'reguli locale (fără AI)')}</td><td class="num">${H(m.documente)}</td>
        <td class="num">${m.incredereMedie == null ? '—' : H(m.incredereMedie + '%')}</td><td class="num">${H(m.eligibileAutomat == null ? m.postateAutomat : m.eligibileAutomat)}</td></tr>`).join('')}</tbody></table>
      <p class="muted">Încrederea e nota pe care și-o dă singur extractorul. Nu autorizează nimic; indică doar banda în care se măsoară rata reală de corecție. Regulile locale nu raportează încredere.</p>`
    : '';
  const calibrari = (r.calibrari || []).length
    ? `<h3>Calibrare pe documente reale revizuite</h3><table><thead><tr><th>Provider AI / model</th><th>Format / tip / bandă</th><th class="num">Eșantion</th><th class="num">Corecții</th><th class="num">Impact fiscal</th><th>Verdict</th></tr></thead><tbody>${
      r.calibrari.map((c) => `<tr><td>${H((c.key.provider || '—') + ' / ' + (c.key.model || 'reguli locale'))}</td>
        <td>${H(c.key.format + ' / ' + (c.key.documentType || 'tip necunoscut') + ' / ' + (c.key.confidenceBand || 'fără scor'))}</td><td class="num">${H(c.samples)}</td>
        <td class="num">${H(c.correctionRate + '%')}</td><td class="num">${H(c.fiscalCorrections)}</td><td>${H(c.status)}</td></tr>`).join('')}</tbody></table>
      <p class="muted">Fără eșantionul minim și fără o rată acceptabilă, politica se abține chiar dacă AI raportează 99%.</p>`
    : '<p class="muted">Calibrarea automatizării nu are încă suficiente documente reale revizuite.</p>';
  const recente = (r.recente || []).length
    ? `<h3>Ultimele corecții</h3><table><thead><tr><th>Document</th><th>Furnizor</th><th>Ce s-a corectat</th><th>Motiv</th></tr></thead><tbody>${
      r.recente.slice(0, 10).map((x) => `<tr><td>${H(x.fileName)} <span class="muted">${H(x.format)}</span></td><td>${H(x.partener)}</td>
        <td class="muted">${H((x.campuri || []).map((c) => c.camp).join(', ') || (x.tipExtras !== x.tipSalvat ? 'tipul documentului' : '—'))}</td>
        <td class="muted">${H(x.motiv || '—')}</td></tr>`).join('')}</tbody></table>`
    : '';
  return kpi + stare + modele + calibrari + tabel('Furnizori care cer corecții', r.furnizori, 'Furnizor')
    + tabel('Formate care cer corecții', r.formate, 'Format')
    // aceeași formă ca pe furnizori/formate: „pe cine merită să-l repari" devine, aici,
    // „extractorul ăsta cere mai multe corecții decât cel dinaintea lui?"
    + tabel('Corecții pe extractor', r.corectiiPeModel, 'Extractor')
    + ((r.peControl || []).length
      ? `<h3>Controale care pică</h3><table><thead><tr><th>Control</th><th class="num">De câte ori</th></tr></thead><tbody>${
        r.peControl.map((c) => `<tr><td>${H(c.nume)}</td><td class="num">${H(c.n)}</td></tr>`).join('')}</tbody></table>`
      : '')
    + recente;
}

async function loadCalitate() {
  const host = $('#calitateView');
  if (!host) return;
  const zile = ($('#calZile') && $('#calZile').value) || 90;
  try { host.innerHTML = calitateRaportHtml(await api('/api/extract-quality?days=' + encodeURIComponent(zile))); }
  catch (e) { host.innerHTML = `<p class="muted">${H(e.message)}</p>`; }
}
$('#calRefresh') && $('#calRefresh').addEventListener('click', loadCalitate);
$('#calZile') && $('#calZile').addEventListener('change', loadCalitate);

export { loadArhiva, loadEntries, loadMissingDocs, renderEntryLists, setEntriesDeps, loadCalitate };
// Exportate pentru testele unitare de frontend (logica pura de clasificare/insigne): test/frontend.mjs
export { etranspCell, entryDir, entryStateBadge, batchTransitionError };
