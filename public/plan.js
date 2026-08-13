'use strict';

// Planul de conturi: afisare pe clase + import CSV personalizat. Extras din app.js (Etapa: spargerea fisierului mare).
import { $$, $, fmt, H, accName, toast, api, META, setMeta, fileToCsv } from './core.js';
import { stare, controaleHtml, leaga, MARIME_IMPLICITA } from './paginare.js';

// ───────────────────────── PLAN ─────────────────────────
// La filtrare se revine la prima pagina: o cautare care da trei rezultate te-ar fi lasat altfel
// pe pagina 8, adica pe un tabel gol peste date care exista.
$('#planFilter').addEventListener('input', () => { PLAN_OFFSET = 0; renderPlan(); });
$('#accCsvFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) { try { $('#accCsvIn').value = await fileToCsv(f); } catch (err) { toast(err.message, true); } } });
$('#accImportBtn').addEventListener('click', async () => {
  const csv = $('#accCsvIn').value.trim(); if (!csv) return toast('Lipiește un CSV', true);
  try {
    const r = await api('/api/accounts/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
    toast(r.importati + ' conturi importate (' + r.totalConturi + ' total)');
    $('#accCsvIn').value = ''; setMeta(await api('/api/meta')); renderPlan();
  } catch (err) { toast(err.message, true); }
});
// Denumirile de conturi NU sunt constante interne: planul se poate extinde prin import CSV
// (/api/accounts/import), deci `nume` e text venit din afara si se escapeaza ca oricare altul.
/** Conturile care trec de filtru. Separată de randare ca să poată fi și numărată, și paginată. */
function planFiltrate(accounts, q) {
  const f = String(q || '').toLowerCase();
  return (accounts || []).filter((a) => !f || String(a.cod).includes(f) || String(a.nume || '').toLowerCase().includes(f));
}
function planRowsHtml(accounts, q) {
  return planFiltrate(accounts, q)
    .map((a) => `<tr><td class="acc">${H(a.cod)}</td><td>${H(a.nume)}</td><td>Clasa ${H(a.clasa)}</td><td>${H(a.tip)}</td></tr>`).join('');
}
// Poziția în plan. Planul vine întreg în META (nu e o rută), deci paginarea e de AFIȘARE — dar
// exact asta doare: peste 700 de conturi construite ca HTML dintr-o dată sunt și lente de randat,
// și imposibil de citit. Filtrul rămâne prima unealtă; paginarea e pentru cine răsfoiește.
let PLAN_OFFSET = 0;
let PLAN_LIMIT = MARIME_IMPLICITA;
function renderPlan() {
  const q = $('#planFilter').value;
  const toate = planFiltrate(META.accounts, q);
  const s = stare(toate.length, PLAN_OFFSET, PLAN_LIMIT);
  PLAN_OFFSET = s.offset;
  // Randurile se construiesc TOT prin `planRowsHtml` (filtrul e deja aplicat, deci ''): o copie a
  // buclei aici ar fi fost calea REALA a interfetei, in timp ce probele de escapare din
  // test/frontend.mjs ar fi continuat sa verifice functia exportata. Testele ar fi ramas verzi
  // peste o randare vulnerabila — exact tiparul „testul trece din motivul gresit".
  const rows = planRowsHtml(toate.slice(s.offset, s.offset + s.limit), '');
  $('#planView').innerHTML = `<table><thead><tr><th>Cont</th><th>Denumire</th><th>Clasa</th><th>Tip</th></tr></thead><tbody>${rows}</tbody></table>`
    + controaleHtml(s, 'plan', 'conturi');
  leaga('#planView', s, (off, lim) => { PLAN_OFFSET = off; PLAN_LIMIT = lim; renderPlan(); });
}

// ── Mod simplu (necontabil) + Dictionar contabil ──
// Extrase in public/simplemode.js (initUiMode e apelat din init).

// ── Solduri inițiale (editor, Setări → preluare firmă cu istoric) ──
let OPEN_ROWS = [];
// ── Parsarea sumelor din balantele importate (formate romanesti si internationale) ──
// „1.234" este AMBIGUU: in scriere romaneasca inseamna o mie doua sute treizeci si patru, dar
// poate fi si 1,234 scris cu punct zecimal. Ghicitul tacit costa un factor de 1000 exact pe
// soldurile de deschidere, care se propaga apoi in toata contabilitatea. De aceea parserul NU
// alege singur: marcheaza valoarea drept ambigua si lasa importul sa intrebe (vezi askSeparator).
const AMOUNT_RE = /^-?\d+(?:[.,]\d+)*$/;
const clean = (raw) => String(raw == null ? '' : raw).trim().replace(/\s/g, '').replace(/lei|ron/gi, '');
const num2 = (str) => { const n = Number(str); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
function splitAmount(s) {
  if (!AMOUNT_RE.test(s)) return null;
  const neg = s.startsWith('-'); const body = neg ? s.slice(1) : s;
  return { sign: neg ? -1 : 1, body, dots: (body.match(/\./g) || []).length, commas: (body.match(/,/g) || []).length };
}
// Rolul separatorilor dedus dintr-un SINGUR token, doar cand tokenul nu lasa loc de interpretare.
// {} inseamna „nu lamureste nimic" — adica exact cazul ambiguu.
function tokenRoles(raw) {
  const s = clean(raw); if (!s) return {};
  const p = splitAmount(s); if (!p) return {};
  const { body, dots, commas } = p;
  // ambii separatori prezenti: ultimul este cel zecimal, celalalt separa miile
  if (dots && commas) {
    return body.lastIndexOf(',') > body.lastIndexOf('.') ? { ',': 'zecimale', '.': 'mii' } : { '.': 'zecimale', ',': 'mii' };
  }
  const ch = dots ? '.' : (commas ? ',' : null);
  if (!ch) return {};
  if ((dots || commas) > 1) return { [ch]: 'mii' }; // un separator zecimal nu apare de doua ori
  const [intPart, frac] = body.split(ch);
  if (frac.length !== 3) return { [ch]: 'zecimale' }; // grupele de mii au EXACT 3 cifre
  if (intPart === '0' || intPart.length > 3) return { [ch]: 'zecimale' }; // „0.500", „1234.567"
  return {}; // 1-3 cifre urmate de exact 3 -> ambiguu
}
// Conventia intregului fisier: o singura linie neambigua („1.234,56" sau „12,5") lamureste
// rolul separatorului pentru toate celelalte, deci nu mai e nevoie sa intrebam utilizatorul.
// Dovezile contradictorii pe acelasi separator anuleaza deducerea (raspunde omul).
function sepConvention(tokens) {
  const roles = {};
  for (const t of tokens || []) {
    const r = tokenRoles(t);
    for (const ch of Object.keys(r)) {
      if (roles[ch] === undefined) roles[ch] = r[ch];
      else if (roles[ch] !== r[ch]) roles[ch] = null;
    }
  }
  return { '.': roles['.'] || null, ',': roles[','] || null };
}
// { value, ambiguous }. `roles` fixeaza rolul separatorilor (dedus din fisier sau ales de om);
// fara el, un token ambiguu este RAPORTAT, nu ghicit — `value` e doar interpretarea de afisat.
function parseAmount(raw, roles) {
  const s = clean(raw);
  if (!s) return { value: 0, ambiguous: false };
  const p = splitAmount(s);
  if (!p) return { value: 0, ambiguous: false };
  const { sign, body, dots, commas } = p;
  if (!dots && !commas) return { value: sign * num2(body), ambiguous: false };
  if (dots && commas) {
    const dec = body.lastIndexOf(',') > body.lastIndexOf('.') ? ',' : '.';
    return { value: sign * num2(body.replace(dec === ',' ? /\./g : /,/g, '').replace(dec, '.')), ambiguous: false };
  }
  const ch = dots ? '.' : ',';
  const asMii = () => sign * num2(body.split(ch).join(''));
  const asZec = () => sign * num2(body.replace(ch, '.'));
  if ((dots || commas) > 1) return { value: asMii(), ambiguous: false };
  const [intPart, frac] = body.split(ch);
  if (frac.length !== 3 || intPart === '0' || intPart.length > 3) return { value: asZec(), ambiguous: false };
  const role = roles && roles[ch];
  if (role === 'mii') return { value: asMii(), ambiguous: false };
  if (role === 'zecimale') return { value: asZec(), ambiguous: false };
  return { value: asZec(), ambiguous: true };
}
function nrRo(s, roles) { return parseAmount(s, roles).value; }
async function renderOpening() {
  let map; try { map = await api('/api/opening'); } catch (e) { return; }
  OPEN_ROWS = Object.keys(map).sort().map((cont) => ({ cont, d: Number(map[cont].d) || 0, c: Number(map[cont].c) || 0 }));
  drawOpening();
  // Preseturile sunt per utilizator (contabilul le refoloseste intre firme), deci se reincarca
  // cand intram in ecran. E best-effort pentru compatibilitatea cu un server vechi in rollout.
  loadMigrationPresets().catch(() => {});
}
function drawOpening() {
  const rows = OPEN_ROWS.map((r, i) => `<tr>
    <td><input class="op-cont acc" data-i="${i}" value="${H(r.cont)}" placeholder="cont" data-u="u90" /></td>
    <td class="muted op-nume">${H(accName(r.cont))}</td>
    <td><input class="op-d num" data-i="${i}" type="number" step="0.01" value="${r.d || ''}" placeholder="0" data-u="u162" /></td>
    <td><input class="op-c num" data-i="${i}" type="number" step="0.01" value="${r.c || ''}" placeholder="0" data-u="u162" /></td>
    <td><button class="linkbtn op-del" data-i="${i}">șterge</button></td></tr>`).join('');
  $('#openEditor').innerHTML = OPEN_ROWS.length
    ? `<table><thead><tr><th>Cont</th><th>Denumire</th><th class="num">Sold debit</th><th class="num">Sold credit</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">Niciun sold inițial. Adaugă conturi sau încarcă balanța din fișier.</p>';
  const totD = Math.round(OPEN_ROWS.reduce((s, r) => s + (r.d || 0), 0) * 100) / 100;
  const totC = Math.round(OPEN_ROWS.reduce((s, r) => s + (r.c || 0), 0) * 100) / 100;
  const dif = Math.round((totD - totC) * 100) / 100;
  $('#openTotals').innerHTML = OPEN_ROWS.length
    ? `Total debit: <b>${fmt(totD)}</b> · Total credit: <b>${fmt(totC)}</b> · ${dif === 0 ? '<span data-u="u12">echilibrat ✓</span>' : `<span data-u="u33">diferență ${fmt(dif)}</span>`}`
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
  $('#openTotals').innerHTML = `Total debit: <b>${fmt(totD)}</b> · Total credit: <b>${fmt(totC)}</b> · ${dif === 0 ? '<span data-u="u12">echilibrat ✓</span>' : `<span data-u="u33">diferență ${fmt(dif)}</span>`}`;
}
$('#openAddRow') && $('#openAddRow').addEventListener('click', () => { OPEN_ROWS.push({ cont: '', d: 0, c: 0 }); drawOpening(); });
const isBalanceLine = (cells) => /^\d/.test(String(cells[0] || '').trim()); // sare antetul si randurile fara cont
// Citeste liniile cu rolurile date; intoarce si tokenurile ramase ambigue, ca sa stim daca
// avem voie sa importam sau trebuie sa intrebam intai.
function openingRowsFrom(lines, roles) {
  const rows = []; const ambig = [];
  for (const line of lines) {
    const cells = line.split(';');
    if (!isBalanceLine(cells)) continue;
    const pd = parseAmount(cells[2], roles); const pc = parseAmount(cells[3], roles);
    if (pd.ambiguous) ambig.push(clean(cells[2]));
    if (pc.ambiguous) ambig.push(clean(cells[3]));
    if (pd.value === 0 && pc.value === 0) continue;
    rows.push({ cont: String(cells[0]).trim(), d: pd.value, c: pc.value });
  }
  return { rows, ambig };
}
// Raspunsul omului completeaza doar ce NU s-a dedus din fisier. Cei doi separatori au roluri
// complementare — daca punctul marcheaza miile, virgula ramane zecimala — deci un singur raspuns
// ii lamureste pe amandoi (conteaza la fisierele care amesteca „1.234" cu „5,678").
function mergeRoles(roles, ch, role) {
  const other = ch === '.' ? ',' : '.';
  const merged = { '.': (roles && roles['.']) || null, ',': (roles && roles[',']) || null };
  merged[ch] = merged[ch] || role;
  merged[other] = merged[other] || (role === 'mii' ? 'zecimale' : 'mii');
  return merged;
}

// ── Importul avansat prin API + preseturi de mapare ──────────────────────────────────────────
// Parserul local de mai sus ramane contractul editorului simplu si e verificat contra serverului,
// dar fisierul real trece prin /api/migrare/preview: acolo XLS/XLSX/DBF, randurile de titlu si
// detectia coloanelor au o singura implementare. Presetul salveaza NUMELE anteturilor; daca
// programul reordoneaza coloanele la urmatorul client, serverul le gaseste din nou corect.
const OPEN_MAP_FIELDS = [
  ['cont', 'Cont'], ['denumire', 'Denumire cont'], ['sid', 'Sold inițial debitor'],
  ['sic', 'Sold inițial creditor'], ['sfd', 'Sold final debitor'], ['sfc', 'Sold final creditor'],
];
let OPEN_MIGRATION_FILE = null;
let OPEN_MIGRATION_PREVIEW = null;
let OPEN_MIGRATION_PRESETS = [];

function renderMigrationPresets(selected) {
  const sel = $('#openPreset'); if (!sel) return;
  const wanted = selected == null ? sel.value : selected;
  sel.innerHTML = '<option value="">Detectare automată</option>'
    + OPEN_MIGRATION_PRESETS.map((p) => `<option value="${H(p.id)}">${H(p.nume)}</option>`).join('');
  if (OPEN_MIGRATION_PRESETS.some((p) => p.id === wanted)) sel.value = wanted;
  const del = $('#openPresetDelete'); if (del) del.classList.toggle('hidden', !sel.value);
}

async function loadMigrationPresets(selected) {
  if (!$('#openPreset')) return;
  const r = await api('/api/migrare/presets');
  OPEN_MIGRATION_PRESETS = Array.isArray(r) ? r : [];
  renderMigrationPresets(selected);
}

function renderMigrationMapping(r) {
  const box = $('#openMapping'); const target = $('#openMappingFields');
  if (!box || !target || !r || !Array.isArray(r.antet)) return;
  OPEN_MIGRATION_PREVIEW = r;
  const options = (selected) => '<option value="">— nefolosită —</option>' + r.antet.map((h, i) =>
    `<option value="${i}"${Number(selected) === i ? ' selected' : ''}>${H(h || ('Coloana ' + (i + 1)))}</option>`).join('');
  target.innerHTML = OPEN_MAP_FIELDS.map(([key, label]) =>
    `<label>${H(label)} <select class="open-map-field" data-key="${key}">${options((r.mapare || {})[key])}</select></label>`).join('');
  box.classList.remove('hidden');
}

function readMigrationMapping() {
  const map = {};
  $$('#openMappingFields .open-map-field').forEach((el) => { if (el.value !== '') map[el.dataset.key] = Number(el.value); });
  return map;
}

function migrationProblems(r) {
  const s = $('#openStatus'); if (!s) return;
  const probleme = (r && r.preview && r.preview.probleme) || [];
  s.className = 'status' + (probleme.length ? ' err' : ' ok');
  s.textContent = probleme.length ? probleme.join(' ') : 'Previzualizare pregătită: verifică maparea și egalitatea debit-credit înainte de salvare.';
}

function askServerSeparator() {
  const box = $('#openAmbig'); if (!box) return;
  box.innerHTML = `<div class="warnbox"><span class="wi">⚠️</span><div><b>Separator zecimal ambiguu — nimic nu s-a importat încă.</b>
    <div class="muted">Alege convenția folosită de programul din care ai exportat balanța.</div>
    <div class="row"><button id="openDecimalComma" class="btn small">Virgula este zecimală (1.234,56)</button>
    <button id="openDecimalDot" class="btn small">Punctul este zecimal (1,234.56)</button>
    <button id="openDecimalCancel" class="btn small ghost">Renunță</button></div></div></div>`;
  $('#openDecimalComma').addEventListener('click', () => previewMigrationFile({ zecimal: ',', mapare: readMigrationMapping() }));
  $('#openDecimalDot').addEventListener('click', () => previewMigrationFile({ zecimal: '.', mapare: readMigrationMapping() }));
  $('#openDecimalCancel').addEventListener('click', () => { box.innerHTML = ''; OPEN_MIGRATION_FILE = null; });
}

async function previewMigrationFile(extra) {
  if (!OPEN_MIGRATION_FILE) return;
  const fd = new FormData(); fd.append('file', OPEN_MIGRATION_FILE);
  const source = $('#openSource'); fd.append('sursa', source ? source.value : 'final');
  const opts = extra || {};
  if (opts.mapare) {
    fd.append('mapare', JSON.stringify(opts.mapare));
    fd.append('idxAntet', String(OPEN_MIGRATION_PREVIEW ? OPEN_MIGRATION_PREVIEW.idxAntet : 0));
  } else {
    const preset = $('#openPreset'); if (preset && preset.value) fd.append('presetId', preset.value);
  }
  if (opts.zecimal) fd.append('zecimal', opts.zecimal);
  try {
    const r = await api('/api/migrare/preview', { method: 'POST', body: fd });
    if ($('#openAmbig')) $('#openAmbig').innerHTML = '';
    renderMigrationMapping(r); migrationProblems(r);
    const rows = ((r.preview || {}).conturi || []).map((x) => ({ cont: x.cont, d: x.d, c: x.c }));
    OPEN_ROWS = rows; drawOpening();
    if ((r.preview || {}).ambigue) askServerSeparator();
    else if (rows.length) toast(rows.length + ' conturi încărcate în previzualizare.');
  } catch (err) { toast(err.message, true); const s = $('#openStatus'); if (s) { s.className = 'status err'; s.textContent = err.message; } }
}

const openFile = $('#openFile');
openFile && openFile.addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  OPEN_MIGRATION_FILE = f; OPEN_MIGRATION_PREVIEW = null;
  e.target.value = ''; // acelasi fisier poate fi reincarcat dupa corectarea formatului
  await previewMigrationFile();
});
const openMappingApply = $('#openMappingApply');
openMappingApply && openMappingApply.addEventListener('click', () => previewMigrationFile({ mapare: readMigrationMapping() }));
const openPresetSave = $('#openPresetSave');
openPresetSave && openPresetSave.addEventListener('click', async () => {
  if (!OPEN_MIGRATION_PREVIEW) return toast('Încarcă și verifică întâi un fișier.', true);
  const name = String(($('#openPresetName') || {}).value || '').trim();
  if (name.length < 2) return toast('Scrie un nume pentru formatul salvat.', true);
  try {
    const r = await api('/api/migrare/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      nume: name, antet: OPEN_MIGRATION_PREVIEW.antet, mapare: readMigrationMapping(),
      sursa: ($('#openSource') || {}).value || 'final', zecimal: OPEN_MIGRATION_PREVIEW.zecimal,
    }) });
    await loadMigrationPresets(r.preset.id); toast(r.creat ? 'Format salvat pentru următoarea firmă.' : 'Formatul salvat a fost actualizat.');
  } catch (err) { toast(err.message, true); }
});
const openPresetSelect = $('#openPreset');
openPresetSelect && openPresetSelect.addEventListener('change', async () => {
  const p = OPEN_MIGRATION_PRESETS.find((x) => x.id === openPresetSelect.value);
  if (p && $('#openSource')) $('#openSource').value = p.sursa || 'final';
  if ($('#openPresetDelete')) $('#openPresetDelete').classList.toggle('hidden', !openPresetSelect.value);
  if (OPEN_MIGRATION_FILE) await previewMigrationFile();
});
const openPresetDelete = $('#openPresetDelete');
openPresetDelete && openPresetDelete.addEventListener('click', async () => {
  const id = openPresetSelect && openPresetSelect.value; if (!id) return;
  if (!confirm('Ștergi acest format salvat?')) return;
  try { await api('/api/migrare/presets/' + encodeURIComponent(id), { method: 'DELETE' }); await loadMigrationPresets(''); toast('Format șters.'); }
  catch (err) { toast(err.message, true); }
});
const openSource = $('#openSource');
openSource && openSource.addEventListener('change', () => { if (OPEN_MIGRATION_FILE) previewMigrationFile({ mapare: OPEN_MIGRATION_PREVIEW ? readMigrationMapping() : null }); });
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

// ── Migrare completa: toate fisierele sunt validate impreuna, apoi scrise atomic ───────────
// Selectoarele sunt intentionat protejate: in timpul unui rollout, un HTML mai vechi poate fi
// servit din cache impreuna cu acest modul nou si nu trebuie sa blocheze restul aplicatiei.
let COMPLETE_MIGRATION_PAYLOAD = null;
const completePreviewBtn = $('#migrationCompletePreview');
const completeImportBtn = $('#migrationCompleteImport');
const completeStatus = $('#migrationCompleteStatus');
const completeSummary = $('#migrationCompleteSummary');

function invalidateCompleteMigration() {
  COMPLETE_MIGRATION_PAYLOAD = null;
  if (completeImportBtn) completeImportBtn.disabled = true;
  if (completeSummary) { completeSummary.innerHTML = ''; completeSummary.classList.add('hidden'); }
}

async function csvFromInput(id) {
  const input = $(id); const file = input && input.files && input.files[0];
  return file ? fileToCsv(file) : '';
}

async function completeMigrationPayload() {
  const [parteneriCsv, activeCsv, stocCsv] = await Promise.all([
    csvFromInput('#migrationPartnersFile'), csvFromInput('#migrationAssetsFile'), csvFromInput('#migrationStockFile'),
  ]);
  const includeBalance = !!(($('#migrationIncludeBalance') || {}).checked);
  if (includeBalance && !OPEN_MIGRATION_PREVIEW) {
    throw new Error('Încarcă și verifică balanța în cardul de mai sus înainte să o incluzi în pachet.');
  }
  return {
    firmaId: META && META.firmaActiva,
    parteneriCsv, activeCsv, stocCsv,
    data: String((($('#migrationDate') || {}).value) || ''),
    zecimal: String((($('#migrationDecimal') || {}).value) || ''),
    conturi: includeBalance ? OPEN_ROWS.map((x) => ({ cont: x.cont, d: Number(x.d) || 0, c: Number(x.c) || 0 })) : [],
  };
}

function showCompleteMigration(r) {
  if (!completeSummary) return;
  const s = r.summary || {}; const problems = Array.isArray(r.problems) ? r.problems : [];
  completeSummary.innerHTML = `<b>Rezumat:</b> ${Number(s.conturi) || 0} conturi · ${Number(s.parteneri) || 0} parteneri · `
    + `${Number(s.active) || 0} mijloace fixe · ${Number(s.pozitiiStoc) || 0} poziții de stoc (${fmt(Number(s.valoareStoc) || 0)} lei)`
    + (problems.length ? `<div class="warnbox"><span class="wi">⚠️</span><div><b>Pachetul nu poate fi importat:</b><ul>${problems.map((x) => `<li>${H(x)}</li>`).join('')}</ul></div></div>`
      : '<p><b>✓ Toate componentele sunt coerente. Previzualizarea nu a modificat datele.</b></p>');
  completeSummary.classList.remove('hidden');
}

['#migrationPartnersFile', '#migrationAssetsFile', '#migrationStockFile', '#migrationDate', '#migrationDecimal', '#migrationIncludeBalance']
  .forEach((id) => { const el = $(id); if (el) el.addEventListener('change', invalidateCompleteMigration); });

completePreviewBtn && completePreviewBtn.addEventListener('click', async () => {
  invalidateCompleteMigration();
  if (completeStatus) { completeStatus.className = 'status'; completeStatus.textContent = 'Se verifică toate componentele…'; }
  try {
    const payload = await completeMigrationPayload();
    const r = await api('/api/migrare/complet/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    showCompleteMigration(r);
    if (r.ok) {
      COMPLETE_MIGRATION_PAYLOAD = payload;
      if (completeImportBtn) completeImportBtn.disabled = false;
      if (completeStatus) { completeStatus.className = 'status ok'; completeStatus.textContent = 'Pachet valid. Nicio dată nu a fost scrisă încă.'; }
    } else if (completeStatus) {
      completeStatus.className = 'status err'; completeStatus.textContent = 'Corectează problemele și verifică din nou pachetul.';
    }
  } catch (err) {
    if (completeStatus) { completeStatus.className = 'status err'; completeStatus.textContent = err.message; }
    toast(err.message, true);
  }
});

completeImportBtn && completeImportBtn.addEventListener('click', async () => {
  if (!COMPLETE_MIGRATION_PAYLOAD) return toast('Verifică din nou pachetul înainte de import.', true);
  let payload = COMPLETE_MIGRATION_PAYLOAD;
  if (completeStatus) { completeStatus.className = 'status'; completeStatus.textContent = 'Se importă pachetul…'; }
  try {
    let r;
    try {
      r = await api('/api/migrare/complet/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (err) {
      if (err.status !== 409 || !confirm(err.message + '\n\nContinui și înlocuiești numai componentele selectate?')) throw err;
      payload = Object.assign({}, payload, { suprascrie: true });
      r = await api('/api/migrare/complet/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }
    COMPLETE_MIGRATION_PAYLOAD = null; completeImportBtn.disabled = true;
    if (completeStatus) { completeStatus.className = 'status ok'; completeStatus.textContent = 'Migrare completă: toate componentele au fost importate împreună.'; }
    showCompleteMigration(Object.assign({ problems: [] }, r));
    await renderOpening();
    toast('Migrarea completă a fost finalizată.');
  } catch (err) {
    if (completeStatus) { completeStatus.className = 'status err'; completeStatus.textContent = err.message; }
    toast(err.message, true);
  }
});


export { renderOpening, renderPlan };
// Exportate pentru testele unitare de frontend (parsarea sumelor in format RO + escaparea
// denumirilor din planul de conturi): test/frontend.mjs
export { nrRo, parseAmount, sepConvention, openingRowsFrom, mergeRoles, planRowsHtml };
