'use strict';

// Rapoarte contabile: jurnal, cartea mare, banca/casa, balanta, TVA/D300, inchideri, situatii. Extras din app.js (Etapa: spargerea fisierului mare).
import { $$, $, H, fmt, toast, api, META, USER, setMeta, fiscalPct, ac, applyFiscalDefaults } from './core.js';
import { renderBudget } from './dashboard.js';
import { pget, workMonth, setWorkMonth, nextMonth, lunaLabel, applyWorkMonth, onPeriodChange } from './periods.js';
import { loadEntries } from './entries.js'; // apelat mai jos; fara import = ReferenceError
import { stare, controaleHtml, leaga } from './paginare.js';
import { registerFormFlow, formFlowFlush, formFlowLoaded, formFlowSaved } from './formflow.js';

// ───────────────────────── JOURNAL ─────────────────────────
onPeriodChange('jurnal', loadJournal);
async function loadJournal() {
  const p = pget('jurnal');
  $('#jurnalPdf').href = '/pdf/journal' + (p ? '?period=' + p : '');
  $('#jurnalCsv').href = '/csv/journal' + (p ? '?period=' + p : '');
  const j = await api('/api/journal' + (p ? '?period=' + p : ''));
  if (!j.rows.length) { $('#jurnalView').innerHTML = '<p class="muted">Nicio înregistrare în perioada selectată.</p>'; return; }
  const rows = j.rows.map((r) => `<tr${r.nr ? ' data-u="u170"' : ''}>
    <td class="num">${r.nr || ''}</td><td>${H(r.data)}</td><td>${H(r.document)}</td><td>${H(r.explicatie)}</td>
    <td class="acc">${r.debit}</td><td class="acc">${r.credit}</td><td class="num">${fmt(r.suma)}</td></tr>`).join('');
  $('#jurnalView').innerHTML = `<table><thead><tr>
    <th>Nr</th><th>Data</th><th>Document</th><th>Explicație</th><th>Cont D</th><th>Cont C</th><th class="num">Sumă</th>
    </tr></thead><tbody>${rows}
    <tr class="total"><td colspan="6">TOTAL</td><td class="num">${fmt(j.total)}</td></tr></tbody></table>`;
}

// ───────────────────────── LEDGER ─────────────────────────
// La schimbarea perioadei se revine la prima pagina: alta luna inseamna alta lista de conturi,
// deci pagina 4 din luna trecuta nu inseamna nimic in cea noua.
onPeriodChange('carte', () => { CARTE_OFFSET = 0; loadLedger(); });
// Poziția în cartea mare. Unitatea paginată e CONTUL, nu rândul: un cont tăiat pe la jumătate,
// cu rulajul și soldul final pe pagina următoare, ar fi de necitit — și ar arăta ca o eroare de
// calcul. Fiecare pagină conține conturi întregi.
let CARTE_OFFSET = 0;
let CARTE_LIMIT = 10;
async function loadLedger() {
  const p = pget('carte');
  $('#cartePdf').href = '/pdf/ledger' + (p ? '?period=' + p : '');
  $('#carteCsv').href = '/csv/ledger' + (p ? '?period=' + p : '');
  const toate = await api('/api/ledger' + (p ? '?period=' + p : ''));
  if (!toate.length) { $('#carteView').innerHTML = '<p class="muted">Nicio mișcare.</p>'; return; }
  const s = stare(toate.length, CARTE_OFFSET, CARTE_LIMIT);
  CARTE_OFFSET = s.offset;
  const accs = toate.slice(s.offset, s.offset + s.limit);
  $('#carteView').innerHTML = accs.map((a) => {
    const moves = a.moves.map((m) => `<tr><td>${H(m.data)}</td><td>${H(m.explicatie)}</td>
      <td class="num">${m.debit ? fmt(m.debit) : ''}</td><td class="num">${m.credit ? fmt(m.credit) : ''}</td></tr>`).join('');
    return `<div class="ledger-acc">
      <h4><span class="acc">${H(a.cod)}</span> — ${H(a.nume)} <a class="linkbtn" href="/pdf/fisa-cont?cont=${encodeURIComponent(a.cod)}${p ? '&period=' + encodeURIComponent(p) : ''}" target="_blank" title="Fișa de cont: mișcări cu cont corespondent și sold curent">fișă de cont</a></h4>
      <p class="muted">Sold inițial: D ${fmt(a.siD)} / C ${fmt(a.siC)}</p>
      <div class="tablewrap"><table><thead><tr><th>Data</th><th>Explicație</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
      <tbody>${moves}
      <tr class="total"><td colspan="2">Rulaj perioadă</td><td class="num">${fmt(a.rd)}</td><td class="num">${fmt(a.rc)}</td></tr>
      <tr class="total"><td colspan="2">Sold final</td><td class="num">${fmt(a.sfD)}</td><td class="num">${fmt(a.sfC)}</td></tr>
      </tbody></table></div></div>`;
  }).join('') + controaleHtml(s, 'carte', 'conturi');
  leaga('#carteView', s, (off, lim) => { CARTE_OFFSET = off; CARTE_LIMIT = lim; loadLedger(); });
}

// ───────────────────────── BANCA / CASA ─────────────────────────
$('#cbCont').addEventListener('change', loadCashbook);
onPeriodChange('cb', loadCashbook);
async function loadCashbook() {
  const cont = $('#cbCont').value; const p = pget('cb');
  const q = '?cont=' + cont + (p ? '&period=' + p : '');
  $('#cbPdf').href = '/pdf/cashbook' + q;
  const cb = await api('/api/cashbook' + q);
  let warnHtml = '';
  if (/^53/.test(cont)) { // control de casa doar pentru numerar
    try {
      const cc = await api('/api/cash-control' + q);
      const items = [];
      cc.negative.forEach((n) => items.push(`<li><b>Sold de casă NEGATIV</b> (${fmt(n.sold)} lei) la ${n.data} — imposibil fizic; verifică ordinea operațiunilor sau o încasare lipsă.</li>`));
      cc.plafon.forEach((w) => items.push(`<li><b>Plafon numerar depășit</b> (Legea 70/2015): ${w.tip === 'plata' ? 'plăți' : 'încasări'} de ${fmt(w.suma)} lei cu „${H(w.partener)}" la ${H(w.data)} — limita ${fmt(w.limita)} lei/zi (${w.juridic ? 'pers. juridică' : 'pers. fizică'}).</li>`));
      // Plafonul TOTAL al zilei e o a doua limită, independentă de cea per persoană: plăți
      // mici către furnizori diferiți o pot depăși fără ca vreuna să iasă din limita ei.
      (cc.plafonTotalZi || []).forEach((z) => items.push(
        `<li><b>Plafon zilnic TOTAL depășit</b> (Legea 70/2015 art. 3): plăți în numerar de ${fmt(z.suma)} lei către persoane juridice la ${H(z.data)} — limita totală ${fmt(z.limita)} lei/zi, indiferent câți furnizori.</li>`));
      // Plafonul de casierie se verifică la sfârșitul FIECĂREI zile, deci se enumeră zilele
      // depășite — un sold final sub limită nu spală o depășire din cursul lunii.
      (cc.zilePesteLimita || (cc.soldPesteLimita ? [cc.soldPesteLimita] : [])).forEach((z) => items.push(
        `<li><b>Sold de casierie peste plafon</b> la ${H(z.data || '')}: ${fmt(z.sold)} lei, limita ${fmt(z.limita)} lei/zi (Legea 70/2015 art. 4) — depune excedentul la bancă.</li>`));
      if (items.length) warnHtml = `<div class="notice warning"><span class="notice-icon">⚠️</span><div><b>Control casă:</b><ul data-u="u171">${items.join('')}</ul></div></div>`;
    } catch (_) { /* control optional */ }
  }
  const rows = cb.rows.map((r) => `<tr><td>${H(r.data)}</td><td>${H(r.document)}</td><td>${H((r.partener ? r.partener + ' — ' : '') + r.explicatie)}</td>
    <td class="num">${r.incasare ? fmt(r.incasare) : ''}</td><td class="num">${r.plata ? fmt(r.plata) : ''}</td><td class="num">${fmt(r.sold)}</td></tr>`).join('');
  $('#cbView').innerHTML = warnHtml + `<p class="muted">Sold inițial: ${fmt(cb.siInitial)} lei</p>
    <table><thead><tr><th>Data</th><th>Document</th><th>Explicație</th><th class="num">Încasări</th><th class="num">Plăți</th><th class="num">Sold</th></tr></thead>
    <tbody>${rows || ''}<tr class="total"><td colspan="3">Rulaje / Sold final</td><td class="num">${fmt(cb.rd)}</td><td class="num">${fmt(cb.rc)}</td><td class="num">${fmt(cb.sfFinal)}</td></tr></tbody></table>`;
  loadCashValuta();
}
async function loadCashValuta() {
  const box = $('#cvView'); if (!box) return;
  const p = pget('cb'); const moneda = ($('#cvMoneda').value || 'EUR').toUpperCase();
  const q = '?moneda=' + encodeURIComponent(moneda) + (p ? '&period=' + p : '');
  $('#cvPdf').href = '/pdf/cash-valuta' + q;
  let reg; try { reg = await api('/api/cash-valuta' + q); } catch (e) { box.innerHTML = ''; return; }
  const rows = reg.rows.map((r) => `<tr><td>${H(r.data)}</td><td>${H(r.document)}</td><td>${H(r.explicatie)}</td>
    <td>${r.moneda || ''}</td><td class="num">${r.curs ? fmt(r.curs) : ''}</td>
    <td class="num">${r.incasareVal ? fmt(r.incasareVal) : ''}</td><td class="num">${r.plataVal ? fmt(r.plataVal) : ''}</td><td class="num">${fmt(r.soldVal)}</td>
    <td class="num">${r.incasareLei ? fmt(r.incasareLei) : ''}</td><td class="num">${r.plataLei ? fmt(r.plataLei) : ''}</td><td class="num">${fmt(r.soldLei)}</td></tr>`).join('');
  box.innerHTML = reg.rows.length
    ? `<p class="muted">Sold inițial lei: ${fmt(reg.siLei)} · monedă afișată: <b>${reg.moneda}</b></p>
      <table><thead><tr><th>Data</th><th>Doc.</th><th>Explicație</th><th>Mon.</th><th class="num">Curs</th><th class="num">Înc. val.</th><th class="num">Plăți val.</th><th class="num">Sold val.</th><th class="num">Înc. lei</th><th class="num">Plăți lei</th><th class="num">Sold lei</th></tr></thead>
      <tbody>${rows}<tr class="total"><td colspan="5">TOTAL ${reg.moneda} / SOLD FINAL</td><td class="num">${fmt(reg.rdVal)}</td><td class="num">${fmt(reg.rcVal)}</td><td class="num">${fmt(reg.soldFinalVal)}</td><td class="num">${fmt(reg.rdLei)}</td><td class="num">${fmt(reg.rcLei)}</td><td class="num">${fmt(reg.soldFinalLei)}</td></tr></tbody></table>`
    : '<p class="muted">Nicio mișcare prin casa în valută<span class="adv"> (5314)</span> în perioadă.</p>';
}
$('#cvMoneda') && $('#cvMoneda').addEventListener('change', loadCashValuta);

// ───────────────────────── BALANCE ─────────────────────────
onPeriodChange('balanta', loadBalance);
let BALANCE_TB = null;
async function loadBalance() {
  const p = pget('balanta');
  $('#balantaPdf').href = '/pdf/balance' + (p ? '?period=' + p : '');
  $('#balantaCsv').href = '/csv/balance' + (p ? '?period=' + p : '');
  BALANCE_TB = await api('/api/balance' + (p ? '?period=' + p : ''));
  renderBalance();
}
$('#balOnlyMoves') && $('#balOnlyMoves').addEventListener('change', renderBalance);
// Cele patru egalitati ale balantei si CARE dintre ele nu se inchide. Extras ca functie pura:
// mesajul indruma contabilul spre cauza, deci o clasificare gresita il trimite sa caute in locul
// nepotrivit. Campurile lipsa se citesc ca 0 — altfel diferenta ar iesi NaN si s-ar afisa ca atare.
const BAL_KEYS = ['siD', 'siC', 'rd', 'rc', 'tsD', 'tsC', 'sfD', 'sfC'];
function balanceEquations(tot) {
  const t = tot || {};
  return [
    ['Sold inițial', t.siD, t.siC],
    ['Rulaje', t.rd, t.rc],
    ['Total sume', t.tsD, t.tsC],
    ['Sold final', t.sfD, t.sfC],
  ].map(([nume, d, c]) => ({ nume, d: Number(d) || 0, c: Number(c) || 0, dif: Math.round(((Number(d) || 0) - (Number(c) || 0)) * 100) / 100 }))
    .filter((x) => x.dif !== 0);
}
// Totalurile randurilor VIZIBILE. La filtrarea „doar miscari", totalul general nu mai corespunde
// cu ce se vede pe ecran, deci se recalculeaza din randurile ramase.
function balanceTotals(rows) {
  return BAL_KEYS.reduce((o, k) => (o[k] = Math.round((rows || []).reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100, o), {});
}
// Balanta are 10 coloane numerice, iar pe o luna obisnuita majoritatea celulelor sunt „0,00":
// pe firma demo, ~100 de zerouri intre care cifrele reale se pierd. Zeroul RAMANE scris (o celula
// goala s-ar citi ca „lipseste valoarea", nu ca „zero", iar coloanele sunt tabular-nums, deci
// alinierea depinde de latimea egala) — doar se stinge, ca ochiul sa cada pe sumele care exista.
const fmt0 = (v) => (Number(v) ? fmt(v) : `<span class="zero">${fmt(v)}</span>`);

function renderBalance() {
  const tb = BALANCE_TB; if (!tb) return;
  if (tb.balanced) {
    $('#balantaStatus').innerHTML = '<p data-u="u172">✔ Balanța se închide — cele patru egalități sunt respectate.</p>';
  } else {
    const eqs = balanceEquations(tb.tot);
    const det = eqs.map((x) => `<b>${H(x.nume)}</b>: debit ${fmt(x.d)} vs credit ${fmt(x.c)} — diferență <b>${fmt(x.dif)}</b>`).join('<br>');
    const initDif = eqs.some((x) => x.nume === 'Sold inițial');
    $('#balantaStatus').innerHTML = `<div data-u="u13"><p data-u="u173">✘ Balanța NU se închide:</p>
      <p data-u="u174">${det}</p>
      ${initDif ? '<p data-u="u175">Diferența pornește de la <b>soldurile inițiale dezechilibrate</b> (total debit ≠ total credit la deschidere) — verifică-le în Setări / import.</p>' : '<p data-u="u175">Verifică ultimele înregistrări din lună.</p>'}</div>`;
  }
  const onlyMoves = $('#balOnlyMoves') && $('#balOnlyMoves').checked;
  const visible = onlyMoves ? tb.rows.filter((r) => r.rd || r.rc) : tb.rows;
  if (!visible.length) { $('#balantaView').innerHTML = `<p class="muted">${onlyMoves ? 'Niciun cont cu mișcări în luna aleasă.' : 'Niciun cont.'}</p>`; return; }
  const rows = visible.map((r) => `<tr>
    <td class="acc">${H(r.cod)}</td><td>${H(r.nume)}</td>
    <td class="num grpsep">${fmt0(r.siD)}</td><td class="num">${fmt0(r.siC)}</td>
    <td class="num grpsep">${fmt0(r.rd)}</td><td class="num">${fmt0(r.rc)}</td>
    <td class="num grpsep">${fmt0(r.tsD)}</td><td class="num">${fmt0(r.tsC)}</td>
    <td class="num grpsep">${fmt0(r.sfD)}</td><td class="num">${fmt0(r.sfC)}</td></tr>`).join('');
  // total: cel general, sau recalculat din rândurile vizibile când filtrăm pe „doar mișcări”
  const t = onlyMoves ? balanceTotals(visible) : tb.tot;
  $('#balantaView').innerHTML = `<table><thead>
    <tr>
      <th rowspan="2">Cont</th><th rowspan="2">Denumire</th>
      <th colspan="2" class="bal-grp si">Sold inițial (reportat)</th>
      <th colspan="2" class="bal-grp ru">Rulaj lună</th>
      <th colspan="2" class="bal-grp su">Total sume</th>
      <th colspan="2" class="bal-grp sf">Sold final</th>
    </tr>
    <tr>
      <th class="num grpsep">Debit</th><th class="num">Credit</th>
      <th class="num grpsep">Debit</th><th class="num">Credit</th>
      <th class="num grpsep">Debit</th><th class="num">Credit</th>
      <th class="num grpsep">Debit</th><th class="num">Credit</th>
    </tr></thead>
    <tbody>${rows}<tr class="total"><td colspan="2">TOTAL</td>
    <td class="num grpsep">${fmt0(t.siD)}</td><td class="num">${fmt0(t.siC)}</td>
    <td class="num grpsep">${fmt0(t.rd)}</td><td class="num">${fmt0(t.rc)}</td>
    <td class="num grpsep">${fmt0(t.tsD)}</td><td class="num">${fmt0(t.tsC)}</td>
    <td class="num grpsep">${fmt0(t.sfD)}</td><td class="num">${fmt0(t.sfC)}</td></tr></tbody></table>`;
}

// ───────────────────────── ARTICOLE STORNATE ─────────────────────────
onPeriodChange('storno', loadStorno);
async function loadStorno() {
  const p = pget('storno');
  if ($('#stornoCsv')) $('#stornoCsv').href = '/csv/storno-report' + (p ? '?period=' + p : '');
  const r = await api('/api/storno-report' + (p ? '?period=' + p : ''));
  if (!r.rows.length) { $('#stornoView').innerHTML = '<p class="muted">Niciun articol stornat în perioada selectată.</p>'; return; }
  $('#stornoView').innerHTML = `<table><thead><tr>
    <th>Data</th><th>Document</th><th>Partener</th><th>Tip</th><th class="num">Sumă</th><th>Notă storno</th><th>Data storno</th>
    </tr></thead><tbody>${r.rows.map((x) => `<tr>
      <td>${H(x.data)}</td><td>${H(x.document)}</td><td>${H(x.partener)}</td><td>${H(x.tip)}</td>
      <td class="num">${fmt(x.total)}</td><td><span class="st st-storno">#${H(String(x.stornoId))}</span></td><td>${H(x.stornoData)}</td>
    </tr>`).join('')}</tbody></table>
    <p class="muted">Total stornat: <b>${fmt(r.total)}</b> lei · ${r.rows.length} ${r.rows.length === 1 ? 'articol' : 'articole'}</p>`;
}

// ───────────────────────── TVA / D300 ─────────────────────────
onPeriodChange('tva', loadVat);
// Pro-rata TVA (art. 300): definitiva calculata din jurnal + regularizarea achizitiilor mixte
async function renderProRata(year) {
  const box = $('#proRataView'); if (!box) return;
  const card = box.closest('.card');
  // Cardul se STRANGE la un rand cand sectiunea nu se aplica: pana acum ramaneau la vedere si
  // explicatia lunga (cinci randuri despre regimul mixt), si motivul — adica o treime de ecran ca
  // sa spuna ca nu te priveste. Titlul ramane, ca optiunea sa nu para pierduta.
  const explic = card && card.querySelector(':scope > p.muted');
  const strange = (da) => {
    if (card) card.classList.toggle('inaplicabil', da);
    if (explic) explic.classList.toggle('hidden', da);
  };
  let r; try { r = await api('/api/pro-rata?year=' + year); } catch (e) { box.innerHTML = ''; strange(false); return; }
  if (!r.provizorie && !r.faraDrept && !r.nrMixte) {
    box.innerHTML = '';
    strange(true);
    if (card && !card.querySelector('.na-motiv')) {
      card.insertAdjacentHTML('beforeend', '<p class="muted na-motiv">nu se aplică firmei tale (fără pro-rata, fără operațiuni scutite fără drept, fără achiziții mixte)</p>');
    }
    return;
  }
  strange(false);
  const vechi = card && card.querySelector('.na-motiv'); if (vechi) vechi.remove();
  box.innerHTML = `<table>
    <tr><td>Livrări CU drept de deducere (taxabile + LIC)</td><td class="num">${fmt(r.cuDrept)}</td></tr>
    <tr><td>Livrări FĂRĂ drept de deducere (scutite)</td><td class="num">${fmt(r.faraDrept)}</td></tr>
    <tr class="total"><td>Pro-rata DEFINITIVĂ ${r.year} (rotunjită în sus)</td><td class="num">${r.definitiva}%</td></tr>
    <tr><td>Pro-rata provizorie (setarea firmei)</td><td class="num">${r.provizorie ? r.provizorie + '%' : '—'}</td></tr>
    <tr><td>Achiziții mixte marcate / TVA dedusă provizoriu</td><td class="num">${r.nrMixte} / ${fmt(r.dedusaProvizoriu)}</td></tr>
    ${r.regularizare != null ? `<tr class="total"><td>Regularizare anuală ${r.regularizare >= 0 ? '(mai ai de dedus — 4426 = 635)' : '(dai înapoi — 635 = 4426)'}</td><td class="num"${Math.abs(r.regularizare) >= 0.01 ? ' data-u="u176"' : ''}>${fmt(Math.abs(r.regularizare))}</td></tr>` : ''}
  </table>
  <p class="muted" data-u="u18">Postezi regularizarea din Documente → „Regularizare anuală pro-rata TVA"; la schimbarea destinației unui mijloc fix folosește „Ajustare TVA bunuri de capital (art. 305)". Clasificarea livrărilor e orientativă — verifică pozițiile atipice cu contabilul.</p>`;
}
$('#exigForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { tip: f.tip.value, brut: f.brut.value, cota: f.cota.value, data: f.data.value, partener: f.partener.value, document: f.document.value };
  try {
    const r = await api('/api/tva-incasare/exigibilitate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const l = r.entry.lines[0];
    $('#exigResult').className = 'status ok';
    $('#exigResult').textContent = `TVA exigibilă: ${fmt(r.tva)} lei — notă ${l.debit} = ${l.credit} (${fmt(l.suma)}).`;
    formFlowSaved(f); f.brut.value = ''; formFlowLoaded(f, 'nou', { restore: false }); loadVat(); loadEntries();
  } catch (err) { $('#exigResult').className = 'status err'; $('#exigResult').textContent = err.message; }
});
function resetExigForm(options = {}) {
  const form = $('#exigForm'); if (!form) return;
  formFlowFlush(form);
  form.reset(); applyFiscalDefaults(form);
  form.data.value = new Date().toISOString().slice(0, 10);
  formFlowLoaded(form, 'nou', { restore: options.restoreDraft !== false });
}
window.addEventListener('contab:company-context', () => resetExigForm());

registerFormFlow({
  form: '#exigForm',
  title: 'Exigibilitatea TVA la încasare',
  firstStepTitle: 'Operațiune și valoare',
  entityKey: 'nou',
  progressFields: ['tip', 'brut', 'cota', 'data', 'partener', 'document'],
  onDiscard: () => resetExigForm({ restoreDraft: false }),
});
async function renderNeexigibila() {
  let n; try { n = await api('/api/tva-neexigibila'); } catch (e) { return; }
  // Acelasi tipar ca la pro-rata: o sectiune care nu se aplica firmei se da la o parte singura si
  // spune DE CE, in loc sa ceara unui necontabil sa deduca dintr-un formular gol ca nu-l priveste.
  // Ascunde formularul si explicatia, nu tot cardul: titlul ramane ca ancora, cu motivul sub el.
  const nimic = !n.colectataNeexigibila && !n.deductibilaNeexigibila && !n.facturi.length;
  const nuSeAplica = nimic && !(META.company && META.company.tvaLaIncasare);
  const na = $('#tvaIncasareNA'); const frm = $('#exigForm');
  if (na) na.classList.toggle('hidden', !nuSeAplica);
  if (frm) frm.classList.toggle('hidden', nuSeAplica);
  $$('#tvaIncasareCard > p.muted.adv').forEach((el) => el.classList.toggle('hidden', nuSeAplica));
  // ...si cardul se strange la un rand, ca la pro-rata: ascunderea formularului lasa altfel un
  // card gol de inaltimea unui titlu plus doua paragrafe, care arata a sectiune stricata.
  const cardTva = $('#tvaIncasareCard');
  if (cardTva) cardTva.classList.toggle('inaplicabil', nuSeAplica);
  if (nimic) { $('#neexigView').innerHTML = ''; return; }
  $('#neexigView').innerHTML = `<table><tbody>
    <tr><td>TVA colectată încă neexigibilă${ac('4428')}</td><td class="num">${fmt(n.colectataNeexigibila)}</td></tr>
    <tr><td>TVA deductibilă încă neexigibilă${ac('4428')}</td><td class="num">${fmt(n.deductibilaNeexigibila)}</td></tr></tbody></table>
    ${n.facturi.length ? `<div class="tablewrap" data-u="u18"><table><thead><tr><th>Data</th><th>Document</th><th>Partener</th><th>Tip</th><th>Stadiu</th><th class="num">TVA</th></tr></thead><tbody>${
      n.facturi.map((f) => `<tr><td>${H(f.data)}</td><td>${H(f.document)}</td><td>${H(f.partener)}</td><td>${H(f.tip)}</td><td>${f.stadiu === 'neexigibila' ? 'neexigibilă' : 'exigibilă'}</td><td class="num">${fmt(f.suma)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
async function loadVat() {
  const p = pget('tva');
  $('#tvaPdf').href = '/pdf/vat' + (p ? '?period=' + p : '');
  renderProRata((p || '').slice(0, 4) || new Date().getFullYear());
  // D300/D394 se generează pe o lună anume; dacă e ales tot anul, dezactivăm link-urile
  const monthly = p && p.length === 7;
  [['#d300Xml', '/xml/d300'], ['#d394Xml', '/xml/d394']].forEach(([id, url]) => {
    const a = $(id); if (!a) return;
    if (monthly) { a.href = url + '?period=' + p; a.style.opacity = ''; a.style.pointerEvents = ''; a.title = ''; }
    else { a.removeAttribute('href'); a.style.opacity = '.45'; a.style.pointerEvents = 'none'; a.title = 'Alege o lună pentru declarația D300/D394'; }
  });
  renderNeexigibila();
  const vj = await api('/api/vat-journals' + (p ? '?period=' + p : ''));
  const t = vj.totals;
  // Perioada, MEREU vizibilă pe card. Aceeași etichetă („TVA de plată") apare și pe dashboard,
  // unde cifra e cumulată pe toate perioadele — fără perioada scrisă lângă ele, cele două numere
  // par să se contrazică. La plătitorul trimestrial decontul agregă cele 3 luni ale trimestrului.
  //
  // Insigna „2026-08" NU era de ajuns: e o dată tehnică, nu o afirmație. Un patron care vede
  // „TVA de plată, cumulat: 5.502" pe Acasă și „TVA de recuperat 0,00" aici nu deduce singur din
  // „2026-08" că a doua cifră e doar a unei luni. Deci perioada se scrie în CUVINTE, în titlu și
  // pe rândul de total, iar puntea către cifra de pe Acasă e explicită.
  const perioadaText = vj.period
    ? (vj.trimestrial ? 'trimestrul care conține ' + lunaLabel(vj.period) : 'luna ' + lunaLabel(vj.period))
    : 'toate lunile, cumulat';
  const trimNota = vj.period
    ? ` <span class="badge adv" title="${vj.trimestrial ? 'TVA trimestrial: decontul agregă cele 3 luni ale trimestrului' : 'Perioada decontului'}">${H(vj.period)}${vj.trimestrial ? ' (trimestru)' : ''}</span>`
    : ' <span class="badge adv" title="Fără lună selectată: totalurile cumulează toate perioadele">cumulat</span>';
  const pentru = vj.period ? ' pentru ' + (vj.trimestrial ? 'trimestru' : lunaLabel(vj.period)) : ' cumulat';
  const deLabel = (t.deplata > 0 ? 'TVA de plată' + ac('4423') : 'TVA de recuperat' + ac('4424')) + pentru;
  const deVal = t.deplata > 0 ? t.deplata : t.derecuperat;
  $('#tvaSummary').innerHTML =
    `<div class="card"><h3>Decontul pe ${H(perioadaText)}${trimNota}</h3>
     ${vj.period ? '<p class="muted">Doar această perioadă. Soldul de TVA <b>cumulat pe toate lunile</b> — cel de pe pagina <b>Acasă</b> — e alt număr, și e normal să difere.</p>' : ''}
     <table>
      <tr><td>TVA colectată${ac('4427')}</td><td class="num">${fmt(t.colectata)}</td></tr>
      <tr><td>TVA deductibilă${ac('4426')}</td><td class="num">${fmt(t.deductibila)}</td></tr>
      <tr class="total"><td>${deLabel}</td><td class="num">${fmt(deVal)}</td></tr>
     </table></div>
     <div class="card"><h3>Defalcare pe cote (D300)</h3><table><thead><tr><th>Cotă</th><th class="num">Bază vânzări</th><th class="num">TVA col.</th><th class="num">Bază cumpărări</th><th class="num">TVA ded.</th></tr></thead><tbody>${
       (() => {
         const cote = [...new Set([...(vj.coteV || []).map((c) => c.cota), ...(vj.coteC || []).map((c) => c.cota)])].sort((a, b) => b - a);
         const cv = Object.fromEntries((vj.coteV || []).map((c) => [c.cota, c]));
         const cc = Object.fromEntries((vj.coteC || []).map((c) => [c.cota, c]));
         return cote.map((k) => `<tr><td>${k ? k + '%' : 'scutit/0%'}</td><td class="num">${cv[k] ? fmt(cv[k].baza) : ''}</td><td class="num">${cv[k] ? fmt(cv[k].tva) : ''}</td><td class="num">${cc[k] ? fmt(cc[k].baza) : ''}</td><td class="num">${cc[k] ? fmt(cc[k].tva) : ''}</td></tr>`).join('')
           + `<tr class="total"><td>TOTAL</td><td class="num">${fmt(t.bazaV)}</td><td class="num">${fmt(t.colectata)}</td><td class="num">${fmt(t.bazaC)}</td><td class="num">${fmt(t.deductibila)}</td></tr>`;
       })()}</tbody></table></div>`;
  const tbl = (rows, totBaza, totTva) => {
    if (!rows.length) return '<p class="muted">Niciun document.</p>';
    const body = rows.map((r) => `<tr><td>${H(r.data)}</td><td>${H(r.document)}</td><td>${H(r.partener)}${r.cui ? ' <span class="muted" data-u="u148">' + H(r.cui) + '</span>' : ''}${r.taxareInversa ? ' <span class="muted" data-u="u148">↹ taxare inversă</span>' : ''}</td>
      <td class="num">${r.cota ? r.cota + '%' : '—'}</td><td class="num">${fmt(r.baza)}</td><td class="num">${fmt(r.tva)}</td><td class="num">${fmt(r.total)}</td></tr>`).join('');
    return `<table><thead><tr><th>Data</th><th>Document</th><th>Partener</th><th class="num">Cotă</th><th class="num">Bază</th><th class="num">TVA</th><th class="num">Total</th></tr></thead>
      <tbody>${body}<tr class="total"><td colspan="4">TOTAL</td><td class="num">${fmt(totBaza)}</td><td class="num">${fmt(totTva)}</td><td class="num">${fmt(totBaza + totTva)}</td></tr></tbody></table>`;
  };
  $('#tvaVanzari').innerHTML = tbl(vj.vanzari, t.bazaV, t.colectata);
  $('#tvaCumparari').innerHTML = tbl(vj.cumparari, t.bazaC, t.deductibila);
  const cq = p ? '?period=' + p : '';
  $('#tvaVanzariCsv').href = '/csv/vat-sales' + cq;
  $('#tvaCumparariCsv').href = '/csv/vat-purchases' + cq;
  renderReconciliere(p);
}

// Reconciliere TVA (pregatire e-TVA): constatarile care ar produce o discrepanta la decontul
// precompletat — cote neconforme si e-Factura emise netrimise in SPV.
async function renderReconciliere(p) {
  const box = $('#tvaReconciliere'); if (!box) return;
  let r; try { r = await api('/api/tva-reconciliere' + (p ? '?period=' + p : '')); } catch (e) { box.innerHTML = ''; return; }
  const icon = { eroare: '⛔', atentie: '⚠️', info: 'ℹ️' };
  const findings = r.findings || [];
  const deta = [];
  if ((r.coteAnormale || []).length) deta.push(`<div class="tablewrap" data-u="u18"><table><thead><tr><th>Tip</th><th>Document</th><th>Partener</th><th class="num">Bază</th><th class="num">TVA</th><th class="num">Cotă</th></tr></thead><tbody>${
    r.coteAnormale.map((a) => `<tr><td>${H(a.tip)}</td><td>${H(a.document)}</td><td>${H(a.partener)}</td><td class="num">${fmt(a.baza)}</td><td class="num">${fmt(a.tva)}</td><td class="num">${a.cota < 0 ? '—' : a.cota + '%'}</td></tr>`).join('')}</tbody></table></div>`);
  if ((r.netrimise || []).length) deta.push(`<div class="tablewrap" data-u="u18"><table><thead><tr><th>Data</th><th>Document</th><th>Partener</th></tr></thead><tbody>${
    r.netrimise.map((n) => `<tr><td>${H(n.data)}</td><td>${H(n.document)}</td><td>${H(n.partener)}</td></tr>`).join('')}</tbody></table></div>`);
  box.innerHTML = `<div class="card"><h3>Reconciliere e-TVA</h3>`
    + (findings.length
      ? `<ul class="checklist todo">${findings.map((f) => `<li>${icon[f.nivel] || '•'} ${H(f.mesaj)}</li>`).join('')}</ul>${deta.join('')}`
      : '<div class="muted">✓ Poziția TVA a perioadei e coerentă — cotele se potrivesc și facturile emise sunt trimise în SPV. Nimic care să producă o discrepanță la decontul precompletat e-TVA.</div>')
    + '<p class="muted" data-u="u28">Verificare internă orientativă: confruntă poziția ta cu ce vede ANAF prin RO e-Factura. Reconcilierea oficială o face decontul precompletat e-TVA după depunere.</p></div>';
}

// Reconciliere decont PRECOMPLETAT e-TVA: importa XML-ul ANAF si il confrunta rand-cu-rand
// cu D300-ul propriu al perioadei (evidentiaza diferentele — simetric cu importul e-Factura primite).
if ($('#etvaReconBtn')) $('#etvaReconBtn').addEventListener('click', runEtvaReconcile);
if ($('#etvaFile')) $('#etvaFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { $('#etvaXmlInput').value = await f.text(); runEtvaReconcile(); } catch (_) { toast('Nu s-a putut citi fișierul.', true); }
});
async function runEtvaReconcile() {
  const box = $('#etvaResult');
  const xmlText = (($('#etvaXmlInput') && $('#etvaXmlInput').value) || '').trim();
  if (!xmlText) { box.innerHTML = '<p class="muted">Alege fișierul XML precompletat sau lipește conținutul.</p>'; return; }
  const p = pget('tva');
  box.innerHTML = '<p class="muted">Se reconciliază…</p>';
  let r;
  try { r = await api('/api/etva-precompletat' + (p ? '?period=' + p : ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ xml: xmlText }) }); }
  catch (e) { box.innerHTML = `<p class="status err">${H(e.message)}</p>`; return; }
  box.innerHTML = renderEtvaResult(r);
}
function renderEtvaResult(r) {
  const icon = { eroare: '⛔', atentie: '⚠️', info: 'ℹ️' };
  const badge = r.ok ? '<span class="pill">✓ concordant</span>' : `<span class="pill warn">${r.diffCount} rând(uri) cu diferențe</span>`;
  const findings = (r.findings || []).length
    ? `<ul class="checklist todo">${r.findings.map((f) => `<li>${icon[f.nivel] || '•'} ${H(f.mesaj)}</li>`).join('')}</ul>` : '';
  const cell = (c) => c
    ? `<td class="num">${fmt(c.propriu)}</td><td class="num">${fmt(c.anaf)}</td><td class="num${c.match ? '' : ' etva-diff'}">${c.delta === 0 ? '—' : (c.delta > 0 ? '+' : '') + fmt(c.delta)}</td>`
    : '<td></td><td></td><td></td>';
  const rows = (r.rows || []).map((row) => `<tr class="${row.match ? '' : 'etva-diff-row'}"><td>${H(row.rand)}</td><td>${H(row.eticheta)}</td>${cell(row.baza)}${cell(row.tva)}</tr>`).join('');
  return `<div class="card" data-u="u18"><div class="card-head"><h4>Comparație cu decontul precompletat</h4>${badge}</div>`
    + `<p class="muted" data-u="u25">Perioada ${H((r.meta && r.meta.period) || '')}. Δ = ANAF − tu (pozitiv: ANAF vede mai mult decât ai declarat).</p>`
    + findings
    + `<div class="tablewrap"><table><thead><tr><th>Rând</th><th>Descriere</th><th class="num">Bază tu</th><th class="num">Bază ANAF</th><th class="num">Δ</th><th class="num">TVA tu</th><th class="num">TVA ANAF</th><th class="num">Δ</th></tr></thead><tbody>${rows}</tbody></table></div>`
    + `<p class="muted" data-u="u28">Decontul precompletat e-TVA se descarcă din SPV. Diferențele trebuie justificate până la termenul din notificarea de conformare.</p></div>`;
}

// ───────────────────────── CLOSINGS ─────────────────────────
onPeriodChange('vc', previewVat);
async function loadClosings() {
  // implicit, luna de inchis = luna de lucru
  const m = workMonth();
  if ($('#vcLuna')) $('#vcLuna').value = m.slice(5);
  if ($('#vcAn') && [...$('#vcAn').options].some((o) => o.value === m.slice(0, 4))) $('#vcAn').value = m.slice(0, 4);
  // Anul din cardul de inventariere urmeaza luna de lucru, ca restul pasilor de inchidere.
  if ($('#invAn')) $('#invAn').value = m.slice(0, 4);
  previewVat(); previewProfitTax(); previewYear(); previewDistribution(); renderRegistruInventar();
}
async function previewVat() {
  const p = pget('vc'); if (!p) { $('#vatPreview').textContent = 'Alege o perioadă.'; return; }
  const v = await api('/api/vat-preview?period=' + p);
  $('#vatPreview').innerHTML = `Luna: <b>${lunaLabel(p)}</b>\nTVA colectată: <b>${fmt(v.colectata)}</b> lei\nTVA deductibilă: <b>${fmt(v.deductibila)}</b> lei\n──────────\n`
    + (v.lines.length ? v.lines.map((l) => `<span class="pd">${l.debit}</span> = <span class="pc">${l.credit}</span>  ${fmt(l.suma)} lei  (${H(l.explicatie)})`).join('\n')
      : 'Nimic de regularizat.');
}
$('#closeVat').addEventListener('click', async () => {
  const p = pget('vc'); if (!p) return toast('Alege o perioadă', true);
  try {
    await api('/api/close-vat?period=' + p, { method: 'POST' });
    setMeta(await api('/api/meta'));
    // avanseaza la luna urmatoare si muta TOATE filtrele (jurnal, balanta etc.) pe noua luna.
    // `nm` e luna CHIAR setata: cand se inchide luna curenta, cea urmatoare ar fi in viitor si
    // luna de lucru ramane pe loc — mesajul si filtrele trebuie sa spuna adevarul, nu intentia.
    const nm = setWorkMonth(nextMonth(p));
    applyWorkMonth();
    loadEntries();
    $('#vcLuna').value = nm.slice(5);
    if ([...$('#vcAn').options].some((o) => o.value === nm.slice(0, 4))) $('#vcAn').value = nm.slice(0, 4);
    toast('Luna ' + lunaLabel(p) + ' închisă.' + (nm === p ? '' : ' Ai trecut la ' + lunaLabel(nm) + '.'));
    previewVat();
  } catch (e) { toast(e.message, true); }
});
$('#yearInput').addEventListener('change', previewYear);
async function previewYear() {
  const y = $('#yearInput').value;
  const pl = await api('/api/statements/pl?year=' + y);
  $('#yearPreview').innerHTML = `Venituri totale: <b>${fmt(pl.venitTotal)}</b> lei\nCheltuieli totale: <b>${fmt(pl.cheltTotal)}</b> lei\n──────────\nRezultat brut: <b>${fmt(pl.rezBrut)}</b> lei`;
}
$('#closeYear').addEventListener('click', async () => {
  const y = $('#yearInput').value;
  try { const r = await api('/api/close-year?year=' + y, { method: 'POST' }); toast('Închidere anuală: rezultat ' + fmt(r.result.rezultat) + ' lei'); setMeta(await api('/api/meta')); loadEntries(); }
  catch (e) { toast(e.message, true); }
});
/**
 * Ajustările manuale ale impozitului pe profit sunt SUPRASCRIERI, nu valori implicite: câmpul gol
 * înseamnă „calculează tu din conturi", iar un 0 trimis înseamnă „zero, exact". Câmpurile porneau
 * cu value="0", deci fiecare cerere trimitea `cheltNedeductibile=0&deduceri=0` și ștergea tot ce
 * calculase motorul de ajustări — inclusiv plafoanele art. 25/40². Se trimit doar când sunt completate.
 * (export: ptParams — testat în test/frontend.mjs)
 */
function ptParams(ned, ded, pierdere) {
  const q = [];
  const gol = (x) => x == null || String(x).trim() === '';
  if (!gol(ned)) q.push('cheltNedeductibile=' + (Number(ned) || 0));
  if (!gol(ded)) q.push('deduceri=' + (Number(ded) || 0));
  if (!gol(pierdere)) q.push('pierdereReportata=' + (Number(pierdere) || 0));
  return q;
}
function ptQuery() {
  const val = (id) => (($(id) || {}).value);
  return ['year=' + (val('#ptYear') || '')].concat(ptParams(val('#ptNed'), val('#ptDed'), val('#ptPierdere'))).join('&');
}
async function previewProfitTax() {
  if (!$('#ptYear')) return;
  try {
    const p = await api('/api/profit-tax-preview?' + ptQuery());
    if ($('#ptPierdere') && $('#ptPierdere').value === '') $('#ptPierdere').placeholder = 'auto: ' + fmt(p.pierdereReportata) + ' (din anul precedent)';
    // Plafonul de 70% (Legea 296/2023) chiar limitează recuperarea când pierderea reportată depășește limita.
    const plafonat = p.plafonReportarePct < 100 && p.pierdereRecuperabilaMax != null && p.pierdereReportata > p.pierdereRecuperabilaMax && p.pierdereRecuperabilaMax > 0;
    const adj = `Profit contabil (venituri − cheltuieli): <b>${fmt(p.profitContabil)}</b>\n+ Nedeductibile: <b>${fmt(p.cheltNedeductibile)}</b> · − Deduceri: <b>${fmt(p.deduceri)}</b> · − Pierdere reportată folosită: <b>${fmt(p.pierdereFolosita)}</b>\n`;
    $('#ptPreview').innerHTML = adj
      + (plafonat ? `<span class="muted">Pierderea recuperabilă e plafonată la ${p.plafonReportarePct}% din profitul impozabil (max ${fmt(p.pierdereRecuperabilaMax)}) — Legea 296/2023.</span>\n` : '')
      + `──────────\nProfit impozabil: <b>${fmt(p.profitImpozabil)}</b> × ${p.cota}% = Impozit: <b>${fmt(p.impozit)}</b> lei`
      + (p.impozit > 0 ? ` → <span class="pd">691</span> = <span class="pc">4411</span>` : ' (pierdere/zero — niciun impozit)')
      + (p.pierdereDeReportat > 0 ? `\n⚠ Pierdere fiscală de reportat în anii următori: <b>${fmt(p.pierdereDeReportat)}</b> lei` : '');
  } catch (e) { /* ignora */ }
}
['#ptNed', '#ptDed', '#ptPierdere'].forEach((id) => { const el = $(id); if (el) el.addEventListener('change', previewProfitTax); });
$('#ptYear') && $('#ptYear').addEventListener('change', previewProfitTax);
// ───────── Registrul-inventar: valorile de inventar si diferentele din evaluare ─────────
// Cele patru coloane ale formularului 14-1-2. Se INTRODUCE doar valoarea de inventar; valoarea
// contabila, diferenta si propunerea de ajustare se DERIVA pe server — o diferenta salvata ar
// ramane adevarata dupa ce soldul se schimba.
async function renderRegistruInventar() {
  const box = $('#invView'); if (!box) return;
  const an = ($('#invAn') && $('#invAn').value) || String(new Date().getFullYear());
  if ($('#invPdf')) $('#invPdf').href = '/pdf/registru-inventar?an=' + encodeURIComponent(an);
  let ri; try { ri = await api('/api/registru-inventar?an=' + encodeURIComponent(an)); } catch (e) { return; }
  const semn = (v) => (v == null ? '' : (v < 0 ? 'neg' : 'poz'));
  box.innerHTML = `<table><thead><tr><th>Cont</th><th>Elementul inventariat</th>
    <th class="num">Valoare contabilă</th><th class="num">Valoare de inventar</th>
    <th class="num">Diferențe</th><th>Cauze / ajustare propusă</th></tr></thead><tbody>${
  ri.rows.map((r) => `<tr>
      <td class="acc">${H(r.cod)}</td>
      <td>${H(r.nume)}</td>
      <td class="num">${fmt(r.valoareContabila)}</td>
      <td class="num">${r.valoareInventar == null ? '<span class="muted">—</span>' : fmt(r.valoareInventar)}</td>
      <td class="num ${semn(r.diferenta)}">${r.diferenta == null ? '' : fmt(r.diferenta)}</td>
      <td>${H(r.cauza || '')}${r.ajustare
    ? ` <span class="pill">${H(r.ajustare.cheltuiala)} = ${H(r.ajustare.cont)} · ${fmt(r.ajustare.suma)}</span>` : ''}</td>
    </tr>`).join('')}</tbody></table>
    <p class="muted">${ri.nrEvaluate} element(e) evaluate, ${ri.nrNeevaluate} fără valoare de inventar. Total diferențe din evaluare: <b>${fmt(ri.totalDiferente)}</b> lei.
    Deprecierile propun articolul de ajustare; îl înregistrezi din „Operațiuni" cu tipurile <b>Constituire ajustare…</b>.</p>`;
}
$('#invAn') && $('#invAn').addEventListener('change', renderRegistruInventar);
$('#invSave') && $('#invSave').addEventListener('click', async () => {
  const body = {
    an: ($('#invAn') || {}).value, cont: (($('#invCont') || {}).value || '').trim(),
    valoareInventar: ($('#invVal') || {}).value, cauza: ($('#invCauza') || {}).value,
  };
  if (!body.cont) return toast('Completează contul', true);
  try {
    const r = await api('/api/inventar-valori', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast(r.sters ? 'Valoare de inventar ștearsă' : 'Valoare de inventar salvată');
    if ($('#invVal')) $('#invVal').value = '';
    if ($('#invCauza')) $('#invCauza').value = '';
    renderRegistruInventar();
  } catch (e) { toast(e.message, true); }
});

$('#closeProfitTax') && $('#closeProfitTax').addEventListener('click', async () => {
  // Aceeasi regula ca la previzualizare: se trimit doar campurile completate (vezi ptParams).
  const body = { year: $('#ptYear').value };
  for (const p of ptParams(($('#ptNed') || {}).value, ($('#ptDed') || {}).value, ($('#ptPierdere') || {}).value)) {
    const [k, val] = p.split('='); body[k] = Number(val);
  }
  try { const r = await api('/api/close-profit-tax', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast(r.message || ('Impozit pe profit înregistrat: ' + fmt(r.result.impozit) + ' lei')); setMeta(await api('/api/meta')); loadEntries(); previewProfitTax(); }
  catch (e) { toast(e.message, true); }
});
$('#distYear') && $('#distYear').addEventListener('change', previewDistribution);
async function previewDistribution() {
  const y = $('#distYear').value;
  const r = await api('/api/distribute-preview?year=' + y);
  const txt = r.sold121 === 0 ? 'Soldul contului 121 este 0 — nimic de repartizat.'
    : r.profit ? `Profit în 121: <b>${fmt(r.profit)}</b> lei\n→ se înregistrează: <b>121 = 117</b> ${fmt(r.profit)} lei`
      : `Pierdere în 121: <b>${fmt(r.pierdere)}</b> lei\n→ se înregistrează: <b>117 = 121</b> ${fmt(r.pierdere)} lei`;
  $('#distPreview').innerHTML = txt;
}
$('#distResult') && $('#distResult').addEventListener('click', async () => {
  const y = $('#distYear').value;
  try {
    const r = await api('/api/distribute-result?year=' + y, { method: 'POST' });
    toast(r.message || (r.result.profit ? 'Profit repartizat (121→117): ' + fmt(r.result.profit) + ' lei' : 'Pierdere reportată (117→121): ' + fmt(r.result.pierdere) + ' lei'));
    setMeta(await api('/api/meta')); loadEntries();
  } catch (e) { toast(e.message, true); }
});

// ── Reevaluare valutara ──
$('#fxLoad') && $('#fxLoad').addEventListener('click', async () => {
  const asOf = $('#fxAsOf').value;
  if (!asOf) return toast('Alege data reevaluării', true);
  const area = $('#fxRevalArea'); area.innerHTML = '<p class="muted">Se încarcă…</p>';
  $('#fxRevalPreview').innerHTML = ''; $('#fxRevalPost').classList.add('hidden'); $('#fxRevalStatus').textContent = '';
  let list; try { list = await api('/api/fx-reval/candidates?asOf=' + asOf); } catch (e) { area.innerHTML = `<p class="status err">${e.message}</p>`; return; }
  if (!list.length) { area.innerHTML = '<p class="muted">Niciun cont în valută cu sold la această dată (5124/5314 sau conturi cu mișcări în valută).</p>'; return; }
  area.innerHTML = `<table><thead><tr><th>Cont</th><th>Denumire</th><th>Tip</th><th class="num">Sold contabil (lei)</th><th>Mon.</th><th class="num">Sold în valută</th><th class="num">Curs închidere</th></tr></thead>
    <tbody>${list.map((c) => `<tr data-cont="${H(c.cont)}" data-asset="${c.isAsset ? 1 : 0}">
      <td class="acc">${H(c.cont)}</td><td>${H(c.nume)}</td><td>${c.isAsset ? 'Activ' : 'Datorie'}</td><td class="num">${fmt(c.bookLei)}</td><td>${H(c.moneda)}</td>
      <td class="num"><input class="fx-val" type="number" step="0.01" value="${c.foreignBalance || ''}" data-u="u177"></td>
      <td class="num"><input class="fx-curs" type="number" step="0.0001" placeholder="ex. 4.97" data-u="u178"></td></tr>`).join('')}</tbody></table>
    <button id="fxBnrBtn" class="btn" data-u="u23">Ia cursul BNR de la ${H(asOf)}</button>
    <button id="fxPreviewBtn" class="btn" data-u="u23">Previzualizează diferențele</button>`;
  $('#fxPreviewBtn').addEventListener('click', fxPreview);
  // Cursul se completeaza din cursul OFICIAL al datei de reevaluare, nu al zilei de azi. Ramane
  // editabil: feed-ul cazut sau o valuta nepublicata nu blocheaza reevaluarea manuala.
  $('#fxBnrBtn').addEventListener('click', async () => {
    let luate = 0; let lipsa = []; let aproximate = 0;
    for (const tr of document.querySelectorAll('#fxRevalArea tbody tr')) {
      const mon = tr.children[4].textContent.trim();
      try {
        const r = await api('/api/curs-bnr?moneda=' + encodeURIComponent(mon) + '&data=' + asOf);
        if (r.rezultat && r.rezultat.curs > 0) {
          tr.querySelector('.fx-curs').value = r.rezultat.curs;
          luate += 1;
          if (!r.rezultat.exact) aproximate += 1;
        } else lipsa.push(mon);
      } catch (e) { lipsa.push(mon); }
    }
    const parti = [luate + ' curs(uri) completate'];
    if (aproximate) parti.push(aproximate + ' din ultima zi publicată înainte');
    if (lipsa.length) parti.push('lipsă pentru ' + [...new Set(lipsa)].join(', ') + ' — completează manual');
    toast(parti.join('; '), lipsa.length > 0);
  });
});
function fxItems() {
  return $$('#fxRevalArea tbody tr').map((tr) => ({
    cont: tr.dataset.cont, foreignBalance: Number(tr.querySelector('.fx-val').value) || 0, closingRate: Number(tr.querySelector('.fx-curs').value) || 0,
  })).filter((it) => it.closingRate > 0);
}
async function fxPreview() {
  const asOf = $('#fxAsOf').value; const items = fxItems();
  if (!items.length) return toast('Completează cel puțin un curs de închidere', true);
  let r; try { r = await api('/api/fx-reval/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asOf, items }) }); } catch (e) { return toast(e.message, true); }
  const box = $('#fxRevalPreview');
  if (!r.lines.length) { box.innerHTML = '<p class="muted">Nicio diferență de reevaluare (soldurile coincid cu cursul indicat).</p>'; $('#fxRevalPost').classList.add('hidden'); return; }
  box.innerHTML = `<table><thead><tr><th>Cont</th><th>Sold contabil</th><th>Reevaluat</th><th>Diferență</th><th>Sens</th><th>Notă</th></tr></thead>
    <tbody>${r.results.filter((x) => x.lines.length).map((x) => `<tr><td class="acc">${x.account}</td><td class="num">${fmt(x.book)}</td><td class="num">${fmt(x.revaluedLei)}</td>
      <td class="num" data-style="color:${x.sens === 'favorabila' ? 'var(--accent)' : 'var(--danger)'}">${x.diff >= 0 ? '+' : ''}${fmt(x.diff)}</td>
      <td>${x.sens}</td><td class="acc">${x.lines[0].debit} = ${x.lines[0].credit}</td></tr>`).join('')}
    <tr class="total"><td colspan="3">Total favorabil (765) / nefavorabil (665)</td><td class="num">+${fmt(r.totalFavorabil)} / −${fmt(r.totalNefavorabil)}</td><td colspan="2"></td></tr></tbody></table>`;
  $('#fxRevalPost').classList.remove('hidden');
}
$('#fxRevalPost') && $('#fxRevalPost').addEventListener('click', async () => {
  const asOf = $('#fxAsOf').value; const items = fxItems();
  try {
    const r = await api('/api/fx-reval/post', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asOf, items }) });
    $('#fxRevalStatus').className = 'status ok';
    $('#fxRevalStatus').textContent = 'Reevaluare înregistrată: favorabil ' + fmt(r.totalFavorabil) + ' lei (765), nefavorabil ' + fmt(r.totalNefavorabil) + ' lei (665).';
    $('#fxRevalArea').innerHTML = ''; $('#fxRevalPreview').innerHTML = ''; $('#fxRevalPost').classList.add('hidden');
    loadEntries();
  } catch (e) { $('#fxRevalStatus').className = 'status err'; $('#fxRevalStatus').textContent = e.message; }
});

// ───────────────────────── STATEMENTS ─────────────────────────
// Situatiile si anexele lor stau in doua pagini, dar sunt ACELEASI cifre pe acelasi an: cele doua
// campuri de an se oglindesc. Doua ani independenti ar fi lasat bilantul pe 2026 si notele pe 2025
// fara ca nimic sa spuna de ce — o divergenta tacuta intre doua ecrane care se citesc impreuna.
$('#stmtYear').addEventListener('change', loadStatements);
$('#anexeYear') && $('#anexeYear').addEventListener('change', () => {
  $('#stmtYear').value = $('#anexeYear').value; loadStatements();
});
$('#bugetYear') && $('#bugetYear').addEventListener('change', loadBuget);
$('#regfiscalYear') && $('#regfiscalYear').addEventListener('change', loadRegFiscal);
// ── SAF-T (D406) ── mutat in „Declaratii ANAF": acolo il promite meniul, langa celelalte
// declaratii. Foloseste perioada paginii aceleia, nu anul situatiilor financiare — SAF-T nu e o
// situatie financiara, e o declaratie informativa.
async function loadSaft() {
  const box = $('#saftView'); if (!box) return;
  // perioada paginii PROPRII (#saftLuna/#saftAn) de cand SAF-T a iesit din lista de declaratii
  const an = (pget('saft') || new Date().toISOString().slice(0, 7)).slice(0, 4);
  const luna = pget('saft') || workMonth();
  $('#saftXml') && ($('#saftXml').href = '/xml/saft?year=' + an);
  $('#saftXmlLuna') && ($('#saftXmlLuna').href = '/xml/saft?period=' + luna);
  return api('/api/saft?year=' + an).then((s) => {
    $('#saftView').innerHTML = `<table>
      <tr><td>Articole contabile (tranzacții)</td><td class="num">${s.entries}</td></tr>
      <tr><td>Conturi cu sold/rulaj</td><td class="num">${s.accounts}</td></tr>
      <tr><td>Clienți / Furnizori</td><td class="num">${s.customers} / ${s.suppliers}</td></tr>
      <tr><td>Facturi vânzare / cumpărare (SourceDocuments)</td><td class="num">${s.salesInvoices} / ${s.purchaseInvoices}</td></tr>
      <tr><td>Plăți/încasări (Payments)</td><td class="num">${s.payments}</td></tr>
      <tr><td>Produse / mișcări stoc (Products, MovementOfGoods)</td><td class="num">${s.products} / ${s.stockMovements}</td></tr>
      <tr><td>Total debit = total credit</td><td class="num">${fmt(s.totalDebit)}</td></tr></table>`;
  }).catch(() => { $('#saftView').innerHTML = ''; });
}
onPeriodChange('saft', loadSaft);

// ── Buget vs realizat ── control de gestiune, INTERN: nu se depune nicaieri si nu tine de
// situatiile financiare anuale. De aceea are pagina lui, nu un card la coada bilantului.
function loadBuget() {
  const el = $('#bugetYear'); if (!el) return;
  renderBudget(el.value);
}

// ── Registrul de evidenta fiscala ── drumul de la rezultatul CONTABIL la cel FISCAL (baza D101).
// Tine de impozitul pe profit, nu de situatiile financiare — de aceea sta in grupul Taxe.
function loadRegFiscal() {
  const el = $('#regfiscalYear'); if (!el) return;
  const y = el.value;
  // PFA: in locul registrului fiscal SRL (profit vs micro), estimarea Declaratiei Unice
  if (META.company && META.company.tipEntitate === 'pfa') {
    api('/api/declaratia-unica?year=' + y).then((du) => {
      $('#fiscalView').innerHTML = `<p class="muted" data-u="u88"><b>PFA — sistem real:</b> impozitul se plătește anual prin <b>Declarația Unică</b>, pe venitul net. Estimare pe salariul minim de ${fmt(du.salariuMinim)} lei:</p>
      <table>
        <tr><td>Venituri din activitate</td><td class="num">${fmt(du.venituri)}</td></tr>
        <tr><td>− Cheltuieli deductibile</td><td class="num">${fmt(du.cheltuieli)}</td></tr>
        <tr class="total"><td>= Venit net anual</td><td class="num">${fmt(du.venitNet)}</td></tr>
        <tr><td>CAS ${fiscalPct('cas', 25)} ${du.bazaCas ? '(bază ' + fmt(du.bazaCas) + ')' : '<span class="muted">(sub 12 salarii minime — opțională)</span>'}</td><td class="num">${fmt(du.cas)}</td></tr>
        <tr><td>CASS ${fiscalPct('cass', 10)} (bază ${fmt(du.bazaCass)}, între 6 și 60 salarii minime)</td><td class="num">${fmt(du.cass)}</td></tr>
        <tr><td>Impozit pe venit ${fiscalPct('impozitVenit', 10)} (după deducerea CAS și CASS)</td><td class="num">${fmt(du.impozit)}</td></tr>
        <tr class="total"><td>TOTAL taxe (Declarația Unică)</td><td class="num">${fmt(du.total)}</td></tr>
      </table>
      <p class="muted" data-u="u98"><b>Variantă pe încasat/plătit</b> (fiscalitatea PFA în sistem real e pe încasări): venit net ${fmt(du.incasat.venitNet)} lei → taxe ${fmt(du.incasat.total)} lei. Alege baza corectă împreună cu contabilul.</p>
      <p class="muted" data-u="u73">Se depune personal, din SPV, până la termenul legal.
        <a class="linkbtn" href="/pdf/declaratia-unica?year=${y}" target="_blank">⬇ Recap PDF</a> ·
        <a class="linkbtn" href="/pdf/registru-incasari-plati?period=${y}" target="_blank" title="Registrul-jurnal de încasări și plăți (partidă simplă)">⬇ Registru încasări-plăți</a></p>`;
    }).catch(() => {});
  } else {
  api('/api/registru-fiscal?year=' + y).then((rf) => {
    const pctTxt = (c) => c.pct < 100 ? ` <span class="muted">(${c.pct}% din ${fmt(c.baza)})</span>` : '';
    $('#fiscalView').innerHTML = `<table>
      <tr><td>Rezultat contabil (brut)</td><td class="num">${fmt(rf.rezultatContabil)}</td></tr>
      ${rf.cheltNeded.map((c) => `<tr><td>+ ${H(c.cod)} ${H(c.nume)}${pctTxt(c)}</td><td class="num">${fmt(c.suma)}</td></tr>`).join('')}
      <tr><td>+ Total cheltuieli nedeductibile</td><td class="num">${fmt(rf.totalNeded)}</td></tr>
      ${(rf.ajustariPlafon || []).map((a) => `<tr><td>+ ${H(a.regula)} <span class="muted">(${H(a.temei)} — cheltuit ${fmt(a.cheltuit)}, deductibil ${fmt(a.plafon)})</span></td><td class="num">${fmt(a.nedeductibil)}</td></tr>`).join('')}
      ${(rf.ajustariPlafon || []).length ? `<tr><td>+ Total depasiri de plafon</td><td class="num">${fmt(rf.totalPlafoane)}</td></tr>` : ''}
      ${(rf.venituriList || []).map((c) => `<tr><td>− ${H(c.cod)} ${H(c.nume)}${pctTxt(c)}</td><td class="num">${fmt(c.suma)}</td></tr>`).join('')}
      <tr><td>− Total venituri neimpozabile</td><td class="num">${fmt(rf.venituriNeimpozabile)}</td></tr>
      <tr class="total"><td>= Rezultat fiscal</td><td class="num">${fmt(rf.rezultatFiscal)}</td></tr>
      <tr class="total"><td>Impozit pe profit ${rf.rateProfit}%</td><td class="num">${fmt(rf.impozitProfit)}</td></tr>
      <tr><td class="muted">(comparativ) Impozit micro ${rf.rateMicro}% din baza art. 53 (${fmt(rf.bazaMicro)})</td><td class="num">${fmt(rf.impozitMicro)}</td></tr>
    </table>${(rf.mentiuni || []).map((m) => `<p class="muted" data-u="u184">${m}</p>`).join('')}`;
  }).catch(() => {});
  }
}

async function loadStatements() {
  // necontabilii isi depun singuri declaratiile, dar bilantul cere semnatura calificata (L82/1991)
  $('#bilantWarn').classList.toggle('hidden', USER.tip !== 'necontabil');
  const y = $('#stmtYear').value;
  if ($('#anexeYear')) $('#anexeYear').value = y;
  $('#plPdf').href = '/pdf/pl?year=' + y;
  $('#bilantPdf').href = '/pdf/bilant?period=' + y + '-12';
  $('#situatiiPdf').href = '/pdf/situatii?year=' + y;
  $('#cashflowPdf').href = '/pdf/cashflow?year=' + y;
  $('#capitalPdf').href = '/pdf/capital?year=' + y;
  $('#fiscalPdf').href = '/pdf/registru-fiscal?year=' + y;
  $('#notesPdf').href = '/pdf/note?year=' + y;
  // NU se mai scriu aici linkurile SAF-T: panoul a plecat de mult din „Situatii financiare", dar
  // liniile au ramas si RESCRIAU adresele paginii SAF-T cu anul situatiilor — doi scriitori pe
  // acelasi href, ultimul castiga. Singurul proprietar e acum `loadSaft()`.
  api('/api/notes?year=' + y).then((n) => {
    const noteSec = (s) => {
      let body;
      if (s.tabel) {
        const head = '<tr>' + s.tabel.cols.map((c) => `<th class="${c.num ? 'num' : ''}" data-style="text-align:${c.num ? 'right' : 'left'}">${c.label}</th>`).join('') + '</tr>';
        const body2 = s.tabel.rows.map((row) => '<tr' + (row._bold ? ' class="total"' : '') + '>' + s.tabel.cols.map((c) =>
          `<td class="${c.num ? 'num' : ''}">${c.num ? (row[c.k] == null ? '—' : fmt(row[c.k])) : (row[c.k] == null ? '' : row[c.k])}</td>`).join('') + '</tr>').join('');
        body = head + body2;
      } else {
        body = s.linii.map((l) => `<tr${l._bold ? ' class="total"' : ''}><td>${l.k}</td><td class="num">${l.v == null ? '—' : (l.raw ? l.v : fmt(l.v))}</td></tr>`).join('');
      }
      return `<p data-u="u179"><b>${s.titlu}</b></p><table>${body}</table>`;
    };
    $('#notesView').innerHTML = n.sections.map(noteSec).join('')
      + '<p data-u="u180"><b>Nota 7 — Principii și politici contabile</b></p><ul class="muted" data-u="u181">'
      + n.principii.map((p) => `<li>${p}</li>`).join('') + '</ul>';
  }).catch(() => {});
  api('/api/statements/cashflow?year=' + y).then((cf) => {
    const cr = (label, val, cls) => `<tr class="${cls || ''}"><td>${label}</td><td class="num">${fmt(val)}</td></tr>`;
    const cs = (label, val) => `<tr><td data-u="u182" class="muted">${label}</td><td class="num">${fmt(val)}</td></tr>`;
    $('#cashflowView').innerHTML = `<table>
      ${cr('Activitatea de exploatare', '', 'total')}
      ${cs('Încasări de la clienți', cf.ex_clienti)}${cs('Plăți către furnizori și angajați', cf.ex_furnizoriAngajati)}${cs('Plăți impozite, taxe și TVA', cf.ex_impozite)}${cs('Dobânzi plătite', cf.ex_dobanzi)}${cs('Alte încasări/plăți din exploatare', cf.ex_altele)}
      ${cr('= Numerar net din exploatare', cf.ex_net, 'total')}
      ${cr('Activitatea de investiție', '', 'total')}
      ${cs('Plăți/încasări privind imobilizările', cf.inv_imobilizari)}${cs('Dobânzi și dividende încasate', cf.inv_dobanziDiv)}
      ${cr('= Numerar net din investiție', cf.inv_net, 'total')}
      ${cr('Activitatea de finanțare', '', 'total')}
      ${cs('Credite/împrumuturi (trageri − rambursări)', cf.fin_credite)}${cs('Aporturi de capital', cf.fin_capital)}${cs('Dividende plătite', cf.fin_dividende)}
      ${cr('= Numerar net din finanțare', cf.fin_net, 'total')}
      ${cr('VARIAȚIA NETĂ A NUMERARULUI', cf.variatie, 'bold')}
      ${cs('Numerar la începutul exercițiului', cf.numerarInitial)}${cs('Numerar la sfârșitul exercițiului', cf.numerarFinal)}</table>
      <p class="${cf.echilibrat ? '' : 'status err'}" data-u="u35">${cf.echilibrat ? '✔ Control: variația = numerar final − inițial (' + fmt(cf.variatieControl) + ')' : '✘ Variația calculată diferă de variația soldurilor de numerar'}</p>`;
  }).catch(() => { $('#cashflowView').innerHTML = ''; });
  api('/api/statements/equity?year=' + y).then((eq) => {
    const er = (r, cls) => `<tr class="${cls || ''}"><td>${H(r.nume)}</td><td class="num">${fmt(r.soldI)}</td><td class="num">${fmt(r.cresteri)}</td><td class="num">${fmt(r.reduceri)}</td><td class="num">${fmt(r.soldF)}</td></tr>`;
    $('#capitalView').innerHTML = `<table>
      <tr><th data-u="u183">Element</th><th class="num">Sold ${Number(y) - 1}-12-31</th><th class="num">Creșteri</th><th class="num">Reduceri</th><th class="num">Sold ${y}-12-31</th></tr>
      ${eq.rows.map((r) => er(r)).join('')}
      ${er(Object.assign({ nume: 'TOTAL CAPITALURI PROPRII' }, eq.total), 'bold')}</table>
      <p class="${eq.echilibrat ? '' : 'status err'}" data-u="u35">${eq.echilibrat ? '✔ Control: total = capitalurile proprii din bilanț (F10)' : '✘ Totalul diferă de capitalurile din F10 (' + fmt(eq.capitalPropriiF10) + ')'}</p>`;
  }).catch(() => { $('#capitalView').innerHTML = ''; });
  const Y0 = Number(y) - 1;
  const [pl, pl0] = await Promise.all([
    api('/api/statements/pl-f20?year=' + y),
    api('/api/statements/pl-f20?year=' + Y0).catch(() => null),
  ]);
  const pcell = (o, k) => (o ? fmt(o[k]) : '—');
  const pr = (label, key, cls) => `<tr class="${cls || ''}"><td>${label}</td><td class="num">${pcell(pl0, key)}</td><td class="num">${fmt(pl[key])}</td></tr>`;
  $('#plView').innerHTML = `<table>
    <tr><th data-u="u183"></th><th class="num">Ex. precedent ${Y0}</th><th class="num">Ex. curent ${y}</th></tr>
    ${pr('1. Cifra de afaceri netă', 'cifraAfaceri')}
    ${pr('2. Variația stocurilor / producția imobilizată', 'venitProductie')}
    ${pr('3. Alte venituri din exploatare', 'alteVenitExpl')}
    ${pr('VENITURI DIN EXPLOATARE — TOTAL', 'venitExpl', 'total')}
    ${pr('4. Cheltuieli cu materii prime, mărfuri, utilități', 'cheltMateriale')}
    ${pr('5. Cheltuieli cu personalul', 'cheltPersonal')}
    ${pr('6. Ajustări de valoare (amortizări)', 'amortizare')}
    ${pr('7. Alte cheltuieli de exploatare', 'alteCheltExpl')}
    ${pr('CHELTUIELI DIN EXPLOATARE — TOTAL', 'cheltExpl', 'total')}
    ${pr('REZULTAT DIN EXPLOATARE', 'rezExpl', 'bold')}
    ${pr('8. Venituri financiare', 'venitFin')}
    ${pr('9. Cheltuieli financiare', 'cheltFin')}
    ${pr('REZULTAT FINANCIAR', 'rezFin', 'total')}
    ${pr('VENITURI TOTALE', 'venitTotal')}
    ${pr('CHELTUIELI TOTALE', 'cheltTotal')}
    ${pr('REZULTAT BRUT', 'rezBrut', 'bold')}
    ${pr('10. Impozit pe profit / venit', 'impozit')}
    ${pr('REZULTAT NET AL EXERCIȚIULUI', 'rezNet', 'bold')}</table>
    <p class="muted" data-u="u185">Structură F20 prescurtat (cont de profit și pierdere, OMFP 1802/2014), cu două coloane: exercițiul precedent și cel curent. Rândurile „Alte..." sunt reziduale, astfel încât totalurile coincid cu rulajul claselor 6 și 7.</p>`;
  const [bs, bs0] = await Promise.all([
    api('/api/statements/bilant-f10?period=' + y + '-12'),
    api('/api/statements/bilant-f10?period=' + Y0 + '-12').catch(() => null),
  ]);
  const r = bs.randuri; const r0 = bs0 ? bs0.randuri : null;
  const row = (label, key, cls) => `<tr class="${cls || ''}"><td>${label}</td><td class="num">${pcell(r0, key)}</td><td class="num">${fmt(r[key])}</td></tr>`;
  const sub = (label, key) => `<tr><td data-u="u182" class="muted">${label}</td><td class="num">${pcell(r0, key)}</td><td class="num">${fmt(r[key])}</td></tr>`;
  const rowT = (label, cur, prev, cls) => `<tr class="${cls || ''}"><td>${label}</td><td class="num">${prev == null ? '—' : fmt(prev)}</td><td class="num">${fmt(cur)}</td></tr>`;
  $('#bilantView').innerHTML = `<table>
    <tr><th data-u="u183"></th><th class="num">Început ex. (${Y0})</th><th class="num">Sfârșit ex. (${y})</th></tr>
    ${row('A. Active imobilizate', 'A', 'total')}
    ${sub('Imobilizări necorporale', 'A_necorp')}${sub('Imobilizări corporale', 'A_corp')}${sub('Imobilizări financiare', 'A_financ')}
    ${row('B. Active circulante', 'B', 'total')}
    ${sub('Stocuri', 'B_stocuri')}${sub('Creanțe', 'B_creante')}${sub('Investiții pe termen scurt', 'B_investTS')}${sub('Casa și conturi la bănci', 'B_casa')}
    ${row('C. Cheltuieli în avans', 'C_cheltAvans')}
    ${rowT('TOTAL ACTIV (A+B+C)', bs.totalActiv, bs0 ? bs0.totalActiv : null, 'bold')}
    ${row('D. Datorii ce trebuie plătite într-un an (curente)', 'D_datorii')}
    ${row('E. Active circulante nete', 'E_activeCircNete')}
    ${row('F. Total active minus datorii curente', 'F_totalMinusDat')}
    ${row('G. Datorii ce trebuie plătite peste un an', 'G_datoriiLT')}
    ${row('H. Provizioane', 'H_provizioane')}
    ${row('I. Venituri în avans', 'I_venitAvans')}
    ${row('J. Capital și rezerve (capitaluri proprii)', 'J_capital', 'total')}
    ${sub('din care rezultatul exercițiului', 'rezultatCurent')}
    ${rowT('TOTAL PASIV (J+D+G+H+I)', bs.totalPasiv, bs0 ? bs0.totalPasiv : null, 'bold')}</table>
    <p class="${bs.echilibrat ? '' : 'status err'}">${bs.echilibrat ? '✔ Activ = Pasiv (bilanț echilibrat)' : '✘ Activ ≠ Pasiv'}</p>
    <p class="muted" data-u="u185">Structură F10 prescurtat (OMFP 1802/2014), cu două coloane: sold la începutul exercițiului (31 dec. ${Y0}) și la sfârșit (31 dec. ${y}). Conturile bifuncționale (clasa 4) se clasifică după sold; datoriile pe termen lung = grupa 16.</p>`;
}


export { loadBalance, loadCashbook, loadClosings, loadJournal, loadLedger, loadStatements, loadStorno, loadVat, loadSaft, loadBuget, loadRegFiscal };
// Exportate pentru testele unitare de frontend (diagnosticul balantei, comparatia e-TVA si
// suprascrierile impozitului pe profit): test/frontend.mjs
export { balanceEquations, balanceTotals, renderEtvaResult, ptParams };
