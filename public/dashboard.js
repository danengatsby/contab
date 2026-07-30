'use strict';
// Dashboard (tab-ul Acasa) + analize derivate: KPI-uri, rezumat executiv, alerte, primii pasi,
// buget vs realizat, previziune cash-flow, comparatie an-la-an si graficele SVG. Extras din app.js
// (Etapa 5). Depinde de nucleu; navigarea intre tab-uri (goTab) e INJECTATA prin setDashboardDeps.
import { $, $$, api, fmt, H, META, toast } from './core.js';

let deps = {};
export function setDashboardDeps(d) { deps = d; }

// ───────────────────────── DASHBOARD ─────────────────────────
// tendinta unei serii lunare (ultima luna cu date vs precedenta), in %
function trendOf(series, key) {
  const d = (series || []).filter((m) => m.venituri || m.cheltuieli)
    .map((m) => (key === 'profit' ? (m.venituri - m.cheltuieli) : (m[key] || 0)));
  if (d.length < 2) return null;
  const cur = d[d.length - 1]; const prev = d[d.length - 2];
  if (!prev) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}
function trendChip(pct, goodWhenUp) {
  if (pct == null || !isFinite(pct)) return '';
  const up = pct >= 0; const good = up === goodWhenUp;
  return `<span class="trend ${good ? 'good' : 'bad'}" title="față de luna precedentă">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}%</span>`;
}
export async function loadDashboard() {
  let k; try { k = await api('/api/dashboard'); } catch (e) { return; }
  let c = null; try { c = await api('/api/dashboard-charts'); } catch (e) { /* grafice optionale */ }
  $('#dashYear').textContent = 'Exercițiul ' + k.year;
  renderDashAlerts(k);
  renderPrimiiPasi(k.primiiPasi);
  const s = (c && c.monthly) || [];
  const cinfo = (info) => info ? `<span class="cinfo" tabindex="0" role="note" aria-label="${info}">i<span class="cpop">${info}</span></span>` : '';
  const card = (ic, lbl, val, sub, cls, trend, info) => `<div class="kpi ${cls || ''}">
    <div class="kpi-top"><span class="kpi-ic">${ic}</span>${trend || ''}</div>
    <div class="lbl">${lbl}${cinfo(info)}</div><div class="val">${fmt(val)}</div><div class="sub">${sub || ''}</div></div>`;
  const tvaP = k.tvaDePlata >= k.tvaDeRecuperat;
  const yo = k.yoY || {};
  const yoySub = (delta) => delta == null ? ('vs ' + (yo.prevYear || '') + ': fără bază') : ('vs ' + yo.prevYear + ': ' + (delta >= 0 ? '▲ +' : '▼ ') + fmt(delta) + '%');
  $('#kpis').innerHTML =
    card('👥', 'Sold clienți (4111)', k.soldClienti, 'de încasat', 'green', '',
      'Cât au de plătit clienții tăi în total — soldul contului 4111 la zi. Detaliul pe fiecare client e în Scadențar.') +
    card('🏭', 'Sold furnizori (401)', k.soldFurnizori, 'de plătit', 'red', '',
      'Cât datorezi furnizorilor în total — soldul contului 401 la zi.') +
    card('🧾', tvaP ? 'TVA de plată' : 'TVA de recuperat', tvaP ? k.tvaDePlata : k.tvaDeRecuperat, 'cumulat', 'blue', '',
      'Soldul de TVA cumulat (4423/4424 după închideri + luna curentă neînchisă). Decontul exact, pe lună, e în tab-ul TVA.') +
    card('🏦', 'Disponibil bancă (5121)', k.banca, 'sold curent', 'blue', '',
      'Banii din contul bancar în lei, după toate încasările și plățile înregistrate. Un sold negativ înseamnă de regulă încasări lipsă din evidență; dacă e un descoperit de cont real, se reclasifică pe 5191.') +
    card('💵', 'Numerar casă (5311)', k.numerar, 'sold curent', 'blue', '',
      'Numerarul din casierie. Nu poate fi negativ — dacă e, lipsește o încasare din evidență.') +
    card('📈', 'Venituri ' + k.year, k.venituri, yoySub(yo.venituriDelta), 'green', trendChip(trendOf(s, 'venituri'), true),
      'Total venituri (clasa 7) pe anul curent, cu comparația față de anul trecut și tendința ultimelor luni.') +
    card('📉', 'Cheltuieli ' + k.year, k.cheltuieli, yoySub(yo.cheltuieliDelta), 'red', trendChip(trendOf(s, 'cheltuieli'), false),
      'Total cheltuieli (clasa 6) pe anul curent, cu comparația față de anul trecut.') +
    card('💰', 'Rezultat ' + k.year, k.profit, yoySub(yo.profitDelta), k.profit >= 0 ? 'green' : 'red', trendChip(trendOf(s, 'profit'), true),
      'Venituri minus cheltuieli pe anul curent — profitul brut contabil, înainte de impozit.');
  renderYoY(yo);
  renderRezumat(k);
  renderForecast();
  const list = (arr) => arr.length
    ? `<table><tbody>${arr.map((p) => `<tr><td>${H(p.den)}</td><td class="num">${fmt(p.sold)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">—</p>';
  $('#topCreante').innerHTML = list(k.topCreante);
  $('#topDatorii').innerHTML = list(k.topDatorii);
  // ultimele operatiuni + stocurile valoroase (cardul de stocuri dispare la firmele fara stocuri)
  const ops = k.ultimeleOperatiuni || [];
  $('#ultimeleOps').innerHTML = ops.length
    ? `<table><tbody>${ops.map((o) => `<tr><td class="muted">${o.data}</td><td>${H(o.tipNume)}${o.partener ? ' · ' + H(o.partener) : ''}</td><td class="num">${fmt(o.suma)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio operațiune încă — înregistrează primul document.</p>';
  const sv = k.stocuriValoroase || [];
  $('#stocValCard').classList.toggle('hidden', !sv.length);
  if (sv.length) $('#stocuriValoroase').innerHTML = `<table><tbody>${sv.map((x) => `<tr><td>${H(x.denumire)}</td><td class="num">${fmt(x.stocV)}</td></tr>`).join('')}</tbody></table>`;
  if (c) renderDashboardCharts(c); else loadDashboardCharts();
}
// Primii pași (onboarding): checklist viu pentru firmele proaspete — dispare singur după
// ce firma are câteva înregistrări. Fiecare pas se bifează din starea REALĂ a datelor.
function pasiOnboarding(p) {
  return [
    { done: p.firmaCompletata, ic: '🏢', t: 'Completează datele firmei', d: 'Denumirea, CUI-ul și dacă e plătitoare de TVA — apar pe facturi și în declarații.', go: 'setari' },
    { done: p.arePartener, ic: '🤝', t: 'Adaugă primul partener', d: 'Un client sau un furnizor cu care lucrezi — CUI-ul e de ajuns, restul se completează singur.', go: 'parteneri' },
    { done: p.documentInregistrat, ic: '📥', t: 'Înregistrează primul document', d: 'O factură primită, un bon sau o chitanță — poză sau PDF; aplicația citește singură cifrele.', go: 'documente' },
    { done: p.facturaEmisa, ic: '📤', t: 'Emite prima factură', d: 'Client + ce vinzi; numărul, PDF-ul și e-Factura se generează automat.', go: 'emite' },
    { done: p.nrInregistrari >= 3, ic: '✅', t: 'Vezi ce a rezultat', d: 'Situația firmei se construiește singură din documente — banii, TVA-ul, profitul.', go: 'ghid' },
  ];
}
function stepsHtml(pasi) {
  return pasi.map((x, i) => `
    <button class="fstep ${x.done ? 'done' : ''}" data-go="${x.go}" ${x.scroll ? `data-scroll="${x.scroll}"` : ''} aria-label="Pasul ${i + 1}: ${x.t}${x.done ? ' — gata' : ''}">
      <span class="fstep-check" aria-hidden="true">${x.done ? '✔' : i + 1}</span>
      <span class="fstep-body"><b>${x.ic} ${x.t}</b><span class="d">${x.d}</span></span>
      <span class="fstep-go" aria-hidden="true">${x.done ? '' : '→'}</span>
    </button>`).join('');
}
function wireSteps(rootSel, after) {
  $$(rootSel + ' .fstep').forEach((b) => b.addEventListener('click', () => {
    deps.goTab(b.dataset.go);
    if (b.dataset.scroll) setTimeout(() => { const el = document.getElementById(b.dataset.scroll); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 200);
    if (after) after();
  }));
}
function renderPrimiiPasi(p) {
  const card = $('#primiiPasiCard'); if (!card) return;
  // firma are deja activitate -> nu mai e nevoie de ghidaj
  if (!p || (p.nrInregistrari >= 5 && p.firmaCompletata)) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const pasi = pasiOnboarding(p);
  const gata = pasi.filter((x) => x.done).length;
  $('#primiiPasiList').innerHTML = stepsHtml(pasi)
    + `<div class="muted" data-u="u30">${gata} din ${pasi.length} pași făcuți · Nu știi ce tip de document ai? Folosește <b>🧭 Înregistrează ghidat</b> de mai jos.</div>`;
  wireSteps('#primiiPasiList');
  maybeShowWizard(p, pasi);
}
// Wizard-ul de primă autentificare: overlay peste checklist, DOAR pentru firma complet goală
// (nicio înregistrare) și doar dacă utilizatorul nu l-a închis vreodată („Mai târziu" persistă
// pe cont, prin /api/onboarding/dismiss — nu în localStorage). Pașii sunt aceiași cu checklist-ul;
// alegerea unui pas doar închide overlay-ul (checklist-ul rămâne), ✕/„Mai târziu" îl ascund definitiv.
let fwShown = false;
function maybeShowWizard(p, pasi) {
  const w = $('#fwWizard'); if (!w) return;
  if (fwShown || p.wizardAscuns || p.nrInregistrari > 0) return;
  fwShown = true; // o singură dată per sesiune de pagină, chiar dacă dashboard-ul se reîncarcă
  $('#fwSteps').innerHTML = stepsHtml(pasi);
  wireSteps('#fwSteps', () => w.classList.add('hidden'));
  const dismiss = async () => {
    w.classList.add('hidden');
    try { await api('/api/onboarding/dismiss', { method: 'POST' }); } catch (e) { /* demo sau offline: ramane doar pe sesiune */ }
  };
  $('#fwLater').addEventListener('click', dismiss, { once: true });
  $('#fwClose').addEventListener('click', dismiss, { once: true });
  w.classList.remove('hidden');
}
// Rezumatul executiv (mod simplu): situația firmei în limbaj de business, cu drill-down —
// bani disponibili, de încasat, de plătit, obligații stat & salarii, rezultat + termene.
async function renderRezumat(k) {
  const box = $('#rezumatKpis'); if (!box) return;
  $('#rezumatData').textContent = '· la zi, ' + new Date().toLocaleDateString('ro-RO', { day: 'numeric', month: 'long', year: 'numeric' });
  const tile = (ic, lbl, val, sub, cls, go, hint) => `<div class="kpi go ${cls}" data-go="${go}" role="link" tabindex="0" title="${hint}">
    <div class="kpi-top"><span class="kpi-ic">${ic}</span></div>
    <div class="lbl">${lbl}</div><div class="val">${fmt(val)}</div><div class="sub">${sub}</div></div>`;
  const obligatii = Math.round(((k.taxeDatorate || 0) + (k.salariiDePlata || 0)) * 100) / 100;
  box.innerHTML =
    tile('💼', 'Bani disponibili', k.disponibilTotal, 'bancă ' + fmt(k.bancaTotal) + ' · casă ' + fmt(k.casaTotal), 'blue', 'cashbook', 'Deschide Încasări & plăți')
    + tile('📥', 'De încasat de la clienți', k.soldClienti, (k.clientiDeschisi || 0) + (k.clientiDeschisi === 1 ? ' client cu facturi deschise' : ' clienți cu facturi deschise'), 'green', 'analitic', 'Deschide scadențarul pe clienți')
    + tile('📤', 'De plătit către furnizori', k.soldFurnizori, (k.furnizoriDeschisi || 0) + (k.furnizoriDeschisi === 1 ? ' furnizor de plătit' : ' furnizori de plătit'), 'red', 'analitic', 'Deschide scadențarul pe furnizori')
    + tile('🏛️', 'Obligații: stat & salarii', obligatii, 'taxe ' + fmt(k.taxeDatorate) + ' · salarii ' + fmt(k.salariiDePlata), 'red', 'livrabile', 'Deschide declarațiile și termenele');
  $$('#rezumatKpis .kpi.go').forEach((el) => {
    el.addEventListener('click', () => deps.goTab(el.dataset.go));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); deps.goTab(el.dataset.go); } });
  });
  const f = $('#rezumatFooter'); if (!f) return;
  const rez = k.profit >= 0
    ? `<b data-u="u31">profit ${fmt(k.profit)} lei</b>`
    : `<b data-u="u32">pierdere ${fmt(Math.abs(k.profit))} lei</b>`;
  let termen = '';
  try {
    const n = await api('/api/notifications');
    const rest = (n.items || []).filter((i) => i.kind === 'restanta');
    const next = (n.items || []).find((i) => i.kind === 'termen');
    termen = rest.length
      ? ` · <span data-u="u33">${rest.length} ${rest.length === 1 ? 'termen depășit' : 'termene depășite'}</span> — <button class="linkbtn" data-go="notificari">vezi notificările</button>`
      : (next ? ` · următorul termen: <b>${H(next.nume)}</b> — ${next.due}` : ' · niciun termen fiscal în următoarele 7 zile');
  } catch (e) { /* notificarile sunt optionale aici */ }
  f.innerHTML = `<span>Rezultatul anului ${k.year} până azi: ${rez}${termen}</span><span class="spacer"></span>
    <button class="btn small" data-go="cashbook">Încasări & plăți →</button>
    <button class="btn small" data-go="analitic">Scadențar →</button>
    <button class="btn small" data-go="tva">TVA →</button>
    <button class="btn small" data-go="livrabile">Declarații & termene →</button>`;
  $$('#rezumatFooter [data-go]').forEach((b) => b.addEventListener('click', () => deps.goTab(b.dataset.go)));
}

export async function renderBudget(year) {
  const box = $('#budgetView'); if (!box) return;
  let r; try { r = await api('/api/budget-report?year=' + year); } catch (e) { box.innerHTML = ''; return; }
  if (!r.rows.length) { box.innerHTML = '<p class="muted">Niciun cont bugetat pentru ' + year + '. Adaugă mai sus.</p>'; return; }
  const vCell = (row) => {
    // pentru venituri, peste buget = bine; pentru cheltuieli, peste buget = rau
    const good = row.tip === 'venit' ? row.variatie >= 0 : row.variatie <= 0;
    return `<span data-style="color:${good ? 'var(--accent)' : 'var(--danger)'};font-weight:600">${row.variatie >= 0 ? '+' : ''}${fmt(row.variatie)}</span>`;
  };
  const tipLbl = { venit: 'Venit', cheltuiala: 'Cheltuială', alt: 'Alt' };
  const rows = r.rows.map((row) => `<tr><td class="acc">${row.cont}</td><td>${H(row.nume)}</td><td>${tipLbl[row.tip]}</td>
    <td class="num">${fmt(row.buget)}</td><td class="num">${fmt(row.actual)}</td><td class="num">${vCell(row)}</td>
    <td class="num">${row.realizarePct == null ? '—' : fmt(row.realizarePct) + '%'}</td>
    <td><button class="del budDel" data-id="${row.id}" title="Șterge">✕</button></td></tr>`).join('');
  box.innerHTML = `<table><thead><tr><th>Cont</th><th>Denumire</th><th>Tip</th><th class="num">Buget</th><th class="num">Realizat</th><th class="num">Abatere</th><th class="num">Realizare</th><th></th></tr></thead>
    <tbody>${rows}
    <tr class="total"><td colspan="3">Venituri bugetate / realizate</td><td class="num">${fmt(r.totalBugetVenit)}</td><td class="num">${fmt(r.totalActualVenit)}</td><td colspan="2"></td><td></td></tr>
    <tr class="total"><td colspan="3">Cheltuieli bugetate / realizate</td><td class="num">${fmt(r.totalBugetChelt)}</td><td class="num">${fmt(r.totalActualChelt)}</td><td colspan="2"></td><td></td></tr>
    <tr class="bold"><td colspan="3">Rezultat bugetat / realizat</td><td class="num">${fmt(r.rezultatBugetat)}</td><td class="num">${fmt(r.rezultatActual)}</td><td colspan="2"></td><td></td></tr>
    </tbody></table>`;
  $$('#budgetView .budDel').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/budgets/' + b.dataset.id, { method: 'DELETE' }); renderBudget(year); } catch (e) { toast(e.message, true); }
  }));
}
$('#budgetForm') && $('#budgetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/budgets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ an: f.an.value, cont: f.cont.value, suma: f.suma.value }) });
    $('#budgetStatus').className = 'status ok'; $('#budgetStatus').textContent = 'Buget salvat.';
    f.cont.value = ''; f.suma.value = '';
    renderBudget($('#stmtYear') ? $('#stmtYear').value : f.an.value);
  } catch (err) { $('#budgetStatus').className = 'status err'; $('#budgetStatus').textContent = err.message; }
});
async function renderForecast() {
  const box = $('#forecastView'); if (!box) return;
  const months = ($('#fcMonths') && $('#fcMonths').value) || 6;
  let f; try { f = await api('/api/cash-forecast?months=' + months); } catch (e) { box.innerHTML = ''; return; }
  const sign = (v) => (v > 0 ? '+' : '') + fmt(v);
  const rows = f.rows.map((r) => `<tr${r.closing < 0 ? ' data-u="u34"' : ''}>
    <td>${r.period}</td><td class="num">${fmt(r.opening)}</td>
    <td class="num">${r.incClienti ? '+' + fmt(r.incClienti) : ''}</td>
    <td class="num">${r.recIn ? '+' + fmt(r.recIn) : ''}</td>
    <td class="num">${r.platiFurnizori ? '−' + fmt(r.platiFurnizori) : ''}</td>
    <td class="num">${r.recOut ? '−' + fmt(r.recOut) : ''}</td>
    <td class="num" data-style="color:${r.net >= 0 ? 'var(--accent)' : 'var(--danger)'}">${sign(r.net)}</td>
    <td class="num" data-style="font-weight:600;color:${r.closing < 0 ? 'var(--danger)' : 'inherit'}">${fmt(r.closing)}</td></tr>`).join('');
  box.innerHTML = `<p class="muted">Numerar acum: <b>${fmt(f.cashNow)}</b> lei · de încasat: ${fmt(f.openReceivables)} · de plătit: ${fmt(f.openPayables)}</p>
    ${f.riscLichiditate ? `<div class="warnbox"><span class="wi">⚠️</span><div><b>Risc de lichiditate:</b> soldul de numerar proiectat scade până la <b>${fmt(f.minClosing)}</b> lei. Urmărește încasările sau amână plăți.</div></div>` : ''}
    <table><thead><tr><th>Luna</th><th class="num">Sold inițial</th><th class="num">Înc. clienți</th><th class="num">Venit recurent</th><th class="num">Plăți furnizori</th><th class="num">Chelt. recurentă</th><th class="num">Flux net</th><th class="num">Sold final</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="muted" data-u="u35">Model: luna curentă încasează soldurile deschise de clienți și plătește datoriile către furnizori; toate lunile adaugă facturile recurente scadente. Estimare orientativă, nu garanție.</p>`;
}
$('#fcMonths') && $('#fcMonths').addEventListener('change', renderForecast);
function renderYoY(yo) {
  const box = $('#yoyView'); if (!box) return;
  if (!yo || yo.prevYear == null) { box.innerHTML = '<p class="muted">—</p>'; return; }
  const delta = (d, goodUp) => {
    if (d == null) return '<span class="muted">fără bază</span>';
    const good = goodUp ? d >= 0 : d <= 0;
    return `<span data-style="color:${good ? 'var(--accent)' : 'var(--danger)'};font-weight:600">${d >= 0 ? '▲ +' : '▼ '}${fmt(d)}%</span>`;
  };
  const row = (lbl, cur, prev, d, goodUp) => `<tr><td>${lbl}</td><td class="num">${fmt(prev)}</td><td class="num">${fmt(cur)}</td><td class="num">${delta(d, goodUp)}</td></tr>`;
  box.innerHTML = `<table><thead><tr><th>Indicator</th><th class="num">${yo.prevYear}</th><th class="num">${yo.year}</th><th class="num">Variație</th></tr></thead><tbody>
    ${row('Venituri totale', yo.venituri, yo.venituriPrev, yo.venituriDelta, true)}
    ${row('Cheltuieli totale', yo.cheltuieli, yo.cheltuieliPrev, yo.cheltuieliDelta, false)}
    ${row('Rezultat net', yo.profit, yo.profitPrev, yo.profitDelta, true)}
    <tr><td>Marjă netă (%)</td><td class="num">${yo.marjaPrev == null ? '—' : fmt(yo.marjaPrev) + '%'}</td><td class="num">${yo.marja == null ? '—' : fmt(yo.marja) + '%'}</td><td class="num">${yo.marja != null && yo.marjaPrev != null ? delta(Math.round((yo.marja - yo.marjaPrev) * 100) / 100, true) : '—'}</td></tr>
    </tbody></table>
    <p class="muted" data-u="u35">Comparația cumulează tot exercițiul curent față de cel precedent. La marjă, variația e în puncte procentuale.</p>`;
}
// Bandă de alerte acționabile (stil command-center) — calculată din datele deja primite
function renderDashAlerts(k) {
  const box = $('#dashAlerts'); if (!box) return;
  const a = [];
  // Sold creditor pe un cont de bani — PRIMA alertă: cât timp există, „Bani disponibili" de mai jos
  // e mai mic decât pare, deci nicio altă cifră de pe ecran nu merită citită înaintea ei.
  // `nume` vine din planul de conturi, care se poate IMPORTA (dată externă) → escapat cu H.
  const cbn = k.conturiBaniNegative || [];
  if (cbn.length) a.push({ ic: '⚠️', tone: 'bad',
    // Denumirea contului PRIMA, codul ca detaliu tehnic (`.adv`): în modul simplu „5121" nu spune
    // nimic unui necontabil, dar „Conturi la banci in lei" spune.
    txt: cbn.length === 1
      ? `Contul <b>${H(cbn[0].nume)}</b><span class="adv"> (${H(cbn[0].cont)})</span> are sold negativ: <b>${fmt(cbn[0].sold)}</b> lei — probabil lipsesc încasări din evidență`
      : `<b>${cbn.length}</b> conturi de bani au sold negativ (${cbn.map((x) => H(x.nume)).join(', ')}) — probabil lipsesc încasări din evidență`,
    go: 'cashbook', cta: 'Verifică încasările' });
  const ef = k.efactura || {};
  if (ef.count > 0) a.push({ ic: '📤', tone: ef.overdue > 0 ? 'bad' : 'warn',
    txt: '<b>' + ef.count + '</b> facturi emise netrimise în SPV (e-Factura, termen 5 zile lucrătoare)' + (ef.overdue > 0 ? ' — <b>' + ef.overdue + ' cu termen depășit</b>' : ''),
    go: 'iesite', cta: 'Trimite în SPV' });
  // „cumulat" explicit: tab-ul TVA arată decontul UNEI luni, deci fără cuvântul ăsta cele două
  // cifre („5.502" aici, „882" acolo) par să se contrazică.
  if (k.tvaDePlata > k.tvaDeRecuperat && k.tvaDePlata > 0) a.push({ ic: '🧾', tone: 'warn', txt: 'TVA de plată, <b>cumulat</b>: <b>' + fmt(k.tvaDePlata) + '</b> lei', go: 'tva', cta: 'Decont pe lună' });
  if (k.soldFurnizori > 0) a.push({ ic: '🏭', tone: 'warn', txt: '<b>' + fmt(k.soldFurnizori) + '</b> lei de plătit furnizorilor', go: 'cashbook', cta: 'Plăți' });
  if (k.soldClienti > 0) a.push({ ic: '👥', tone: 'info', txt: '<b>' + fmt(k.soldClienti) + '</b> lei de încasat de la clienți', go: 'analitic', cta: 'Scadențar' });
  if (k.profit < 0) a.push({ ic: '⚠️', tone: 'bad', txt: 'Rezultatul anului e <b>pierdere</b> (' + fmt(k.profit) + ' lei)', go: 'situatii', cta: 'Situații' });
  box.innerHTML = a.length
    ? a.map((x) => `<button type="button" class="alert ${x.tone}" data-go="${x.go}"><span class="al-ic">${x.ic}</span><span class="al-tx">${x.txt}</span><span class="al-cta">${x.cta} →</span></button>`).join('')
    : '<div class="alert ok"><span class="al-ic">✅</span><span class="al-tx">Totul pare în regulă — nicio acțiune urgentă pentru moment.</span></div>';
  $$('#dashAlerts .alert[data-go]').forEach((b) => b.addEventListener('click', () => deps.goTab(b.dataset.go)));
}
function renderDashboardCharts(c) {
  $('#chartYear').textContent = c.year;
  $('#chartMonthly').innerHTML = svgMonthly(c.monthly);
  $('#chartAging').innerHTML = svgCompare(c.agingClienti.total, c.agingFurnizori.total);
  $('#chartAgingBars').innerHTML = svgAging(c);
}
const MN = ['', 'Ian', 'Feb', 'Mar', 'Apr', 'Mai', 'Iun', 'Iul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function svgMonthly(monthly) {
  const data = monthly.filter((m) => m.venituri || m.cheltuieli);
  if (!data.length) return '<p class="muted">Fără date pentru acest an.</p>';
  const W = 760; const H = 240; const padL = 46; const padR = 12; const padT = 10; const padB = 26;
  const plotW = W - padL - padR; const plotH = H - padT - padB;
  const max = Math.max(1, ...data.map((m) => Math.max(m.venituri, m.cheltuieli)));
  const gW = plotW / data.length; const bw = Math.min(16, gW / 3);
  const x = (i) => padL + i * gW + gW / 2;
  const y = (v) => padT + plotH - (v / max) * plotH;
  let bars = '';
  data.forEach((m, i) => {
    const cx = x(i);
    bars += `<rect rx="2" x="${(cx - bw - 1).toFixed(1)}" y="${y(m.venituri).toFixed(1)}" width="${bw}" height="${(padT + plotH - y(m.venituri)).toFixed(1)}" fill="#1a9c6b"><title>Venituri ${MN[m.luna]}: ${fmt(m.venituri)}</title></rect>`;
    bars += `<rect rx="2" x="${(cx + 1).toFixed(1)}" y="${y(m.cheltuieli).toFixed(1)}" width="${bw}" height="${(padT + plotH - y(m.cheltuieli)).toFixed(1)}" fill="#e0436a"><title>Cheltuieli ${MN[m.luna]}: ${fmt(m.cheltuieli)}</title></rect>`;
    bars += `<text x="${cx.toFixed(1)}" y="${H - 8}" font-size="10" text-anchor="middle" class="ctxt">${MN[m.luna]}</text>`;
  });
  let grid = '';
  for (let g = 0; g <= 2; g++) { const val = (max / 2) * g; const yy = y(val); grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" class="cgrid"/><text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" font-size="9" text-anchor="end" class="ctxt">${fmt(val)}</text>`; }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" data-u="u36">${grid}<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" class="caxis"/>${bars}</svg>
    <div class="muted" data-u="u35"><span data-u="u37">■</span> Venituri &nbsp; <span data-u="u38">■</span> Cheltuieli</div>`;
}
function svgCompare(creante, datorii) {
  const max = Math.max(1, creante, datorii);
  const bar = (lbl, v, col) => `<div data-u="u39"><div data-u="u40"><span>${lbl}</span><b>${fmt(v)}</b></div><div data-u="u41"><div data-style="width:${(v / max * 100).toFixed(1)}%;height:100%;background:${col}"></div></div></div>`;
  return bar('Creanțe de încasat', creante, '#1a9c6b') + bar('Datorii de plătit', datorii, '#e0436a');
}
function svgAging(c) {
  const seg = [['0-30 zile', '#0b6e4f', 'b0_30'], ['31-60', '#b8860b', 'b31_60'], ['61-90', '#d98300', 'b61_90'], ['>90 zile', '#b00020', 'b90plus']];
  const row = (label, t) => {
    const total = (t && t.total) || 0;
    if (total <= 0) return `<div data-u="u42"><b>${label}</b> <span class="muted">— niciun sold</span></div>`;
    const bar = seg.map((s) => { const w = (t[s[2]] / total) * 100; return w > 0 ? `<div title="${s[0]}: ${fmt(t[s[2]])}" data-style="width:${w.toFixed(1)}%;background:${s[1]}"></div>` : ''; }).join('');
    return `<div data-u="u42"><div data-u="u40"><b>${label}</b><span>${fmt(total)}</span></div><div data-u="u43">${bar}</div></div>`;
  };
  const legend = seg.map((s) => `<span data-style="color:${s[1]}">■</span> ${s[0]}`).join(' &nbsp; ');
  return row('Creanțe (clienți)', c.agingClienti) + row('Datorii (furnizori)', c.agingFurnizori) + `<div class="muted" data-u="u24">${legend}</div>`;
}
async function loadDashboardCharts() {
  let c; try { c = await api('/api/dashboard-charts'); } catch (e) { return; }
  renderDashboardCharts(c);
}

// Exportat pentru testele unitare de frontend (calculul tendintei lunare): test/frontend.mjs
export { trendOf };
