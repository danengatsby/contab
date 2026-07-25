'use strict';

// Planul de conturi: afisare pe clase + import CSV personalizat. Extras din app.js (Etapa: spargerea fisierului mare).
import { $$, $, fmt, H, accName, toast, api, META, setMeta, fileToCsv } from './core.js';

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
// Denumirile de conturi NU sunt constante interne: planul se poate extinde prin import CSV
// (/api/accounts/import), deci `nume` e text venit din afara si se escapeaza ca oricare altul.
function planRowsHtml(accounts, q) {
  const f = String(q || '').toLowerCase();
  return (accounts || [])
    .filter((a) => !f || String(a.cod).includes(f) || String(a.nume || '').toLowerCase().includes(f))
    .map((a) => `<tr><td class="acc">${H(a.cod)}</td><td>${H(a.nume)}</td><td>Clasa ${H(a.clasa)}</td><td>${H(a.tip)}</td></tr>`).join('');
}
function renderPlan() {
  const rows = planRowsHtml(META.accounts, $('#planFilter').value);
  $('#planView').innerHTML = `<table><thead><tr><th>Cont</th><th>Denumire</th><th>Clasa</th><th>Tip</th></tr></thead><tbody>${rows}</tbody></table>`;
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
let OPEN_PENDING = null; // fisierul citit, in asteptarea deciziei asupra separatorului ambiguu
// Confirmarea: NU importam pe baza unei presupuneri. Intrebam O SINGURA DATA, cu exemple reale
// din fisier si cu ambele interpretari calculate, apoi aplicam raspunsul intregului import.
function askSeparator(ambig) {
  const ex = [...new Set(ambig)].slice(0, 5);
  const sample = ex[0];
  const ch = sample.includes(',') ? ',' : '.';
  OPEN_PENDING.ch = ch;
  $('#openAmbig').innerHTML = `<div class="warnbox"><span class="wi">⚠️</span><div>
    <b>Valori ambigue în fișier — nimic nu s-a importat încă.</b>
    Nu pot ști dacă „${H(sample)}" înseamnă <b>${fmt(nrRo(sample, { [ch]: 'mii' }))}</b> lei
    (separatorul marchează miile) sau <b>${fmt(nrRo(sample, { [ch]: 'zecimale' }))}</b> lei (zecimale).
    <div class="muted" data-u="u27">Valori ambigue găsite: ${ex.map((t) => `<span class="acc">${H(t)}</span>`).join(' · ')}</div>
    <div class="row" data-u="u23">
      <button id="ambigMii" class="btn small">„${H(sample)}" = ${fmt(nrRo(sample, { [ch]: 'mii' }))} lei</button>
      <button id="ambigZec" class="btn small">„${H(sample)}" = ${fmt(nrRo(sample, { [ch]: 'zecimale' }))} lei</button>
      <button id="ambigCancel" class="btn small ghost">Renunță</button>
    </div>
    <div class="muted" data-u="u28">Alegerea se aplică întregului fișier. Dacă nu ești sigur, deschide fișierul și verifică o sumă cunoscută.</div>
  </div></div>`;
  $('#ambigMii').addEventListener('click', () => resolveSeparator('mii'));
  $('#ambigZec').addEventListener('click', () => resolveSeparator('zecimale'));
  $('#ambigCancel').addEventListener('click', () => { OPEN_PENDING = null; $('#openAmbig').innerHTML = ''; toast('Import anulat — soldurile au rămas neschimbate'); });
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
function resolveSeparator(role) {
  if (!OPEN_PENDING) return;
  const { lines, roles, ch } = OPEN_PENDING;
  const merged = mergeRoles(roles, ch, role);
  OPEN_PENDING = null; $('#openAmbig').innerHTML = '';
  finishOpeningImport(openingRowsFrom(lines, merged).rows);
}
function finishOpeningImport(rows) {
  if (!rows.length) return toast('Nicio linie cu solduri găsită (aștept coloane Cont;Denumire;SoldDebit;SoldCredit)', true);
  OPEN_ROWS = rows;
  drawOpening();
  toast(rows.length + ' conturi încărcate — verifică echilibrul și salvează');
}
$('#openFile') && $('#openFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  let csv; try { csv = await fileToCsv(f); } catch (err) { return toast(err.message, true); }
  e.target.value = ''; // permite reincarcarea aceluiasi fisier dupa o anulare
  $('#openAmbig').innerHTML = ''; OPEN_PENDING = null;
  const lines = csv.split(/\r?\n/).map((l) => l.replace(/^﻿/, '')).filter((l) => l.trim());
  // conventia se deduce din TOT fisierul inainte de a lua vreo suma de buna
  const tokens = [];
  for (const line of lines) { const cells = line.split(';'); if (isBalanceLine(cells)) tokens.push(cells[2], cells[3]); }
  const roles = sepConvention(tokens);
  const { rows, ambig } = openingRowsFrom(lines, roles);
  if (ambig.length) { OPEN_PENDING = { lines, roles }; return askSeparator(ambig); }
  finishOpeningImport(rows);
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
// Exportate pentru testele unitare de frontend (parsarea sumelor in format RO + escaparea
// denumirilor din planul de conturi): test/frontend.mjs
export { nrRo, parseAmount, sepConvention, openingRowsFrom, mergeRoles, planRowsHtml };
