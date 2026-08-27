'use strict';

// „Luna de lucru” + filtrele Luna/An ale tabelelor — extrase din app.js. applyWorkMonth
// reincarca ecranul curent prin dependinte injectate (setPeriodsDeps), ca modulul sa nu
// depinda de onTab/renderEntryLists din app.js.
import { $, $$, META, toast, uiLanguage } from './core.js';

const D = { renderEntryLists: null, onTab: null };
function setPeriodsDeps(d) { Object.assign(D, d); }

const LUNI = ['Ianuarie', 'Februarie', 'Martie', 'Aprilie', 'Mai', 'Iunie', 'Iulie', 'August', 'Septembrie', 'Octombrie', 'Noiembrie', 'Decembrie'];
const LUNI_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function luniUi() { return uiLanguage() === 'en' ? LUNI_EN : LUNI; }
const ANNUAL_OVERRIDE_IDS = ['annualCockpitYear', 'stmtYear', 'anexeYear', 'rsYear', 'bugetYear', 'regfiscalYear'];
const isElement = (el) => !!el && el.nodeType === 1;
function overrideContainer(el) {
  if (!isElement(el)) return null;
  if (el.classList.contains('period-override')) return el;
  return el.closest('.period-override');
}
function isPeriodOverrideActive(el) {
  const box = overrideContainer(el);
  return !!box && box.dataset.periodOverrideActive === 'true';
}
// Compune strict valoarea controalelor locale. `pget` decide separat dacă suprascrierea este activă.
function localPairPeriod(prefix) {
  const a = $('#' + prefix + 'An'); const l = $('#' + prefix + 'Luna');
  const y = a ? a.value : ''; const m = l ? l.value : '';
  if (!y) return '';
  return m ? (y + '-' + m) : y;
}
// Toate ecranele pornesc din perioada globală. Numai controalele aflate într-un panou activ
// „Suprascrie perioada” pot întoarce altceva (inclusiv un an întreg, prin „Toate lunile”).
function pget(prefix) {
  const a = $('#' + prefix + 'An'); const l = $('#' + prefix + 'Luna');
  const control = isElement(l) ? l : isElement(a) ? a : null;
  if (!control || !isPeriodOverrideActive(control)) return workMonth();
  return localPairPeriod(prefix);
}
// Luna calendaristica de azi, in ora LOCALA. `toISOString()` da UTC, iar in Romania (UTC+2/+3)
// asta inseamna ca in primele ore ale zilei de 1 ale lunii UTC e inca luna trecuta — ca simplu
// implicit trecea neobservat, dar ca PLAFON ar fi blocat utilizatorul in luna precedenta.
function currentMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
// Luna de lucru nu trece in VIITOR. O luna viitoare nu are documente, nici termene, nici solduri:
// toate ecranele ies goale, ceea ce seamana cu o aplicatie stricata, nu cu „nu s-a intamplat inca
// nimic". Plafonul se aplica in AMBELE capete — la scriere (orice apel de setWorkMonth, inclusiv
// cele programatice din notificari si din cautarea globala) si la citire (o valoare veche ramasa
// in localStorage dinainte de plafon nu are voie sa reapara).
const capMonth = (m) => (m > currentMonth() ? currentMonth() : m);

// Ultima luna INCHISA a firmei (firma.lockedUntil): tot ce e <= ea e read-only. Serverul o impune
// prin db.assertPeriodOpen pe toate scrierile datate; aici o folosim ca sa ARATAM starea.
function lockedUntil() { return (META.company && META.company.lockedUntil) || ''; }
/** Luna e inchisa (consultabila, dar nu editabila)? */
function esteInchisa(m, lu) { const L = lu === undefined ? lockedUntil() : lu; return !!L && m <= L; }
/**
 * Se poate trece la luna urmatoare? Doar prin INCHIDEREA lunii curente de lucru — inaintarea
 * libera lasa in urma luni nefinalizate, iar fluxul contabil cere ordine: se inchide, apoi se
 * trece mai departe. In plus, luna urmatoare nu are voie sa fie in viitor.
 * Intoarce si MOTIVUL, ca sageata stinsa sa poata spune de ce, nu doar sa nu reactioneze.
 */
function poateInainte(m, lu, acum) {
  const urm = nextMonth(m);
  if (urm > (acum || currentMonth())) return { ok: false, motiv: 'viitor' };
  if (!esteInchisa(m, lu)) return { ok: false, motiv: 'neinchisa' };
  return { ok: true };
}

// „Luna de lucru” — pornește de la luna curentă și avansează la închiderea de lună
function workMonth() {
  let m = '';
  try { m = localStorage.getItem('contab_workmonth') || ''; } catch (e) { /* ignora */ }
  if (!/^\d{4}-\d{2}$/.test(m)) m = currentMonth();
  const cap = capMonth(m);
  // O valoare viitoare ramasa in stocare se NORMALIZEAZA, nu doar se plafoneaza la afisare:
  // altfel ar sta acolo pana cand timpul o ajunge din urma, si atunci aplicatia ar sari brusc
  // in luna aceea in loc sa porneasca, ca de obicei, pe cea curenta. Se scrie direct (nu prin
  // setWorkMonth), ca sa nu se intre in recursie prin setCurrentPeriod.
  if (cap !== m) { try { localStorage.setItem('contab_workmonth', cap); } catch (e) { /* ignora */ } }
  return cap;
}
// Intoarce luna CHIAR setata (poate diferi de cea ceruta, daca a fost plafonata): apelantii care
// anunta utilizatorul unde a ajuns trebuie sa foloseasca valoarea reala, nu pe cea dorita.
function setWorkMonth(m) {
  m = capMonth(m);
  try { localStorage.setItem('contab_workmonth', m); } catch (e) { /* ignora */ }
  setCurrentPeriod();
  return m;
}
function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function nextMonth(m) { return shiftMonth(m, 1); }
function prevMonth(m) { return shiftMonth(m, -1); }
function lunaLabel(m) { const [y, mo] = m.split('-').map(Number); return luniUi()[mo - 1] + ' ' + y; }

function overrideLabel() { return uiLanguage() === 'en' ? 'Override period' : 'Suprascrie perioada'; }
function resetLabel() { return uiLanguage() === 'en' ? 'Use global period' : 'Folosește perioada globală'; }
function overrideValue(box) {
  const prefix = box.dataset.periodPrefix;
  let value = prefix ? localPairPeriod(prefix) : '';
  const controlId = box.dataset.periodControl;
  if (!value && controlId) { const control = $('#' + controlId); value = control ? control.value : ''; }
  if (/^\d{4}-\d{2}$/.test(value)) return lunaLabel(value);
  if (/^\d{4}$/.test(value)) return value + (uiLanguage() === 'en' ? ' · all months' : ' · toate lunile');
  return value;
}
function renderPeriodOverride(box) {
  if (!box) return;
  const active = isPeriodOverrideActive(box);
  box.classList.toggle('active', active);
  const label = box.querySelector('.period-override-label');
  const value = box.querySelector('.period-override-value');
  const reset = box.querySelector('.period-override-reset');
  const month = box.querySelector('[data-period-field="month"]');
  const year = box.querySelector('[data-period-field="year"]');
  if (label) label.textContent = overrideLabel();
  if (value) value.textContent = active ? overrideValue(box) : '';
  if (reset) reset.textContent = resetLabel();
  if (month) month.textContent = uiLanguage() === 'en' ? 'Month' : 'Lună';
  if (year) year.textContent = uiLanguage() === 'en' ? 'Year' : 'An';
}
function syncOverrideToGlobal(box) {
  if (!box) return;
  const m = workMonth(); const mo = m.slice(5); const yr = m.slice(0, 4);
  if (box.dataset.periodPrefix) {
    const l = $('#' + box.dataset.periodPrefix + 'Luna');
    const a = $('#' + box.dataset.periodPrefix + 'An');
    if (l && [...l.options].some((o) => o.value === mo)) l.value = mo;
    if (a && [...a.options].some((o) => o.value === yr)) a.value = yr;
  }
  if (box.dataset.periodControl) {
    const control = $('#' + box.dataset.periodControl);
    if (control) control.value = control.type === 'month' ? m : yr;
  }
}
function setPeriodOverrideActive(el, active) {
  const box = overrideContainer(el); if (!box) return;
  box.dataset.periodOverrideActive = active ? 'true' : 'false';
  if (!active) box.open = false;
  renderPeriodOverride(box);
}
function resetPeriodOverride(el, notify = true) {
  const box = overrideContainer(el); if (!box) return;
  box.dataset.periodOverrideResetting = 'true';
  setPeriodOverrideActive(box, false);
  syncOverrideToGlobal(box);
  const control = box.querySelector('select, input');
  if (notify && control) control.dispatchEvent(new Event('change', { bubbles: true }));
  delete box.dataset.periodOverrideResetting;
  renderPeriodOverride(box);
}
function makeOverrideShell(source, dataName, dataValue) {
  if (!source || !source.parentNode) return null;
  const box = document.createElement('details');
  box.className = 'period-override';
  box.dataset.periodOverrideActive = 'false';
  box.dataset[dataName] = dataValue;
  const summary = document.createElement('summary');
  const label = document.createElement('span'); label.className = 'period-override-label';
  const value = document.createElement('span'); value.className = 'period-override-value';
  summary.append(label, value);
  const controls = document.createElement('div'); controls.className = 'period-override-controls';
  const reset = document.createElement('button');
  reset.type = 'button'; reset.className = 'btn small ghost period-override-reset';
  reset.addEventListener('click', () => resetPeriodOverride(box));
  source.parentNode.insertBefore(box, source);
  box.append(summary, controls);
  controls.appendChild(reset);
  return { box, controls, reset };
}
function overrideControlChanged(control) {
  const box = overrideContainer(control); if (!box || box.dataset.periodOverrideResetting === 'true') return;
  setPeriodOverrideActive(box, true);
}
function setupPairOverride(luna) {
  if (!isElement(luna) || !/Luna$/.test(luna.id) || overrideContainer(luna)) return;
  const prefix = luna.id.slice(0, -4); const an = $('#' + prefix + 'An');
  if (!isElement(an)) return;
  const shell = makeOverrideShell(luna, 'periodPrefix', prefix); if (!shell) return;
  const monthLabel = document.createElement('label');
  const monthText = document.createElement('span'); monthText.dataset.periodField = 'month';
  monthLabel.append(monthText, luna);
  const yearLabel = document.createElement('label');
  const yearText = document.createElement('span'); yearText.dataset.periodField = 'year';
  yearLabel.append(yearText, an);
  shell.controls.insertBefore(monthLabel, shell.reset);
  shell.controls.insertBefore(yearLabel, shell.reset);
  [luna, an].forEach((control) => control.addEventListener('change', () => overrideControlChanged(control)));
  renderPeriodOverride(shell.box);
}
function setupSingleOverride(control, kind) {
  if (!isElement(control) || overrideContainer(control)) return;
  const source = control.parentElement && control.parentElement.tagName === 'LABEL' ? control.parentElement : control;
  const shell = makeOverrideShell(source, 'periodControl', control.id); if (!shell) return;
  if (source === control) {
    const field = document.createElement('label');
    const text = document.createElement('span');
    text.dataset.periodField = kind;
    field.append(text, control);
    shell.controls.insertBefore(field, shell.reset);
  } else shell.controls.insertBefore(source, shell.reset);
  control.addEventListener('change', () => overrideControlChanged(control));
  syncOverrideToGlobal(shell.box);
  renderPeriodOverride(shell.box);
}
function setupPeriodOverrides() {
  $$('select.luna').forEach(setupPairOverride);
  ANNUAL_OVERRIDE_IDS.forEach((id) => setupSingleOverride($('#' + id), 'year'));
  setupSingleOverride($('#mvfLuna'), 'month');
}
// Vizualizatorul de documente in aplicatie (PDF/CSV/XML/e-Factura) a fost extras in public/viewer.js (Etapa 8).
// Afiseaza luna de lucru in bara de sus (langa firma)
function setCurrentPeriod() {
  const el = $('#currentPeriod'); if (!el) return;
  const m = workMonth();
  el.textContent = lunaLabel(m);
  el.setAttribute('aria-label', (uiLanguage() === 'en' ? 'Global period: ' : 'Perioada globală: ') + lunaLabel(m));
  el.title = uiLanguage() === 'en'
    ? 'Global period: every screen uses this month. Press to choose another month.'
    : 'Perioada globală: toate ecranele folosesc această lună. Apasă pentru a alege altă lună.';
  const picker = $('#globalPeriodInput');
  if (picker) { picker.value = m; picker.max = currentMonth(); }
  const pickerLabel = document.querySelector('#globalPeriodPanel label');
  if (pickerLabel) pickerLabel.textContent = uiLanguage() === 'en' ? 'Global period' : 'Perioada globală';
  const pickerPanel = $('#globalPeriodPanel');
  if (pickerPanel) pickerPanel.setAttribute('aria-label', uiLanguage() === 'en' ? 'Choose global period' : 'Alege perioada globală');
  const current = $('#globalPeriodCurrent');
  if (current) current.textContent = uiLanguage() === 'en' ? 'Current month' : 'Luna curentă';
  // Sageata „inainte": stinsa cand nu se poate merge mai departe, cu MOTIVUL in title. Un buton
  // care nu reactioneaza pare stricat; unul stins care spune de ce e o instructiune.
  const nx = $('#nextMonth');
  if (nx) {
    const v = poateInainte(m);
    nx.disabled = !v.ok;
    nx.setAttribute('aria-disabled', String(!v.ok));
    nx.title = uiLanguage() === 'en'
      ? (v.ok ? 'Next month (' + lunaLabel(nextMonth(m)) + ')'
        : v.motiv === 'viitor' ? 'You are in the current month — future work is not available'
          : 'First close ' + lunaLabel(m) + ' (Closing → Month-end closing) to continue to ' + lunaLabel(nextMonth(m)))
      : (v.ok ? 'Luna următoare (' + lunaLabel(nextMonth(m)) + ')'
        : v.motiv === 'viitor' ? 'Ești pe luna curentă — nu se poate lucra în viitor'
          : 'Închide mai întâi ' + lunaLabel(m) + ' (Închideri → Închiderea lunii) ca să treci la ' + lunaLabel(nextMonth(m)));
  }
  // Banda de „luna inchisa" + marcajul pe <body> care stinge caile de CREARE (vezi styles.css)
  const inchisa = esteInchisa(m);
  document.body.classList.toggle('luna-inchisa', inchisa);
  const bar = $('#lunaInchisaBar');
  if (bar) {
    bar.classList.toggle('hidden', !inchisa);
    // textul se scrie DOAR cand banda se arata: altfel ramane in DOM o afirmatie falsa
    // („Iunie e închisă") care ar deveni vizibila daca cineva ascunde banda altfel decat prin aici
    const t = $('#lunaInchisaText'); if (t) t.textContent = inchisa ? lunaLabel(m) + (uiLanguage() === 'en' ? ' is closed' : ' este închisă') : '';
  }
}
// Aplica luna de lucru pe toate filtrele de tabel si reincarca ecranul curent
function applyWorkMonth() {
  const m = workMonth(); const mo = m.slice(5); const yr = m.slice(0, 4);
  $$('select.luna').forEach((s) => { if (!isPeriodOverrideActive(s) && [...s.options].some((o) => o.value === mo)) s.value = mo; });
  $$('select.an').forEach((s) => { if (!isPeriodOverrideActive(s) && [...s.options].some((o) => o.value === yr)) s.value = yr; });
  // Vederile anuale urmează anul global până când utilizatorul deschide explicit suprascrierea.
  ANNUAL_OVERRIDE_IDS.forEach((id) => { const el = $('#' + id); if (el && !isPeriodOverrideActive(el)) el.value = yr; });
  // Câmpurile de acțiune anuale nu sunt filtre locale; ele urmează întotdeauna anul de lucru.
  ['yearInput'].forEach((id) => { const el = $('#' + id); if (el) el.value = yr; });
  $$('input[type="month"].period').forEach((el) => { if (!isPeriodOverrideActive(el)) el.value = m; });
  $$('.period-override').forEach(renderPeriodOverride);
  if (D.renderEntryLists) D.renderEntryLists();
  const active = document.querySelector('#tabs button[data-tab].active');
  if (active && D.onTab) D.onTab(active.dataset.tab);
}
setupPeriodOverrides();
setCurrentPeriod();
// Navigare luna de lucru din bara de sus
function goWorkMonth(m) { setWorkMonth(m); applyWorkMonth(); }
$('#prevMonth') && $('#prevMonth').addEventListener('click', () => goWorkMonth(prevMonth(workMonth())));
// Garda si pe handler, nu doar pe atributul `disabled`: starea butonului se recalculeaza la
// setCurrentPeriod, iar intre timp META se poate schimba (alta firma, alt lockedUntil).
$('#nextMonth') && $('#nextMonth').addEventListener('click', () => {
  const m = workMonth(); const v = poateInainte(m);
  if (v.ok) return goWorkMonth(nextMonth(m));
  if (v.motiv === 'neinchisa') toast(uiLanguage() === 'en'
    ? 'First close ' + lunaLabel(m) + ' — Closing → Month-end closing.'
    : 'Închide mai întâi ' + lunaLabel(m) + ' — Închideri → Închiderea lunii.', true);
});
// Banda de luna inchisa: duce la prima luna DESCHISA (imediat dupa ultima inchisa), plafonata la
// luna curenta — daca sunt inchise toate lunile pana azi, ramai unde esti.
$('#lunaInchisaGo') && $('#lunaInchisaGo').addEventListener('click', () => {
  const lu = lockedUntil(); if (!lu) return;
  goWorkMonth(nextMonth(lu));
});
function toggleGlobalPeriodPanel(force) {
  const panel = $('#globalPeriodPanel'); const trigger = $('#currentPeriod');
  if (!panel || !trigger) return;
  const open = force === undefined ? panel.classList.contains('hidden') : !!force;
  panel.classList.toggle('hidden', !open);
  trigger.setAttribute('aria-expanded', String(open));
  if (open) { const input = $('#globalPeriodInput'); if (input) { input.value = workMonth(); input.focus(); } }
}
$('#currentPeriod') && $('#currentPeriod').addEventListener('click', (e) => { e.stopPropagation(); toggleGlobalPeriodPanel(); });
$('#globalPeriodPanel') && $('#globalPeriodPanel').addEventListener('click', (e) => e.stopPropagation());
$('#globalPeriodInput') && $('#globalPeriodInput').addEventListener('change', (e) => {
  if (/^\d{4}-\d{2}$/.test(e.target.value)) goWorkMonth(e.target.value);
  toggleGlobalPeriodPanel(false);
});
$('#globalPeriodCurrent') && $('#globalPeriodCurrent').addEventListener('click', () => {
  goWorkMonth(currentMonth()); toggleGlobalPeriodPanel(false);
});
document.addEventListener('click', () => toggleGlobalPeriodPanel(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleGlobalPeriodPanel(false); });

// Leaga schimbarea perechii Lună+An de functia de reincarcare a tabelului
function onPeriodChange(prefix, fn) {
  ['Luna', 'An'].forEach((sfx) => {
    const el = $('#' + prefix + sfx);
    if (!el) return;
    // Schimbarea rămâne locală. Perioada globală se modifică numai din controlul persistent de sus.
    el.addEventListener('change', fn);
  });
}
function fillPeriods() {
  const now = new Date();
  const curY = String(now.getFullYear());
  const years = new Set((META.periods || []).map((p) => String(p).slice(0, 4)).filter((y) => /^\d{4}$/.test(y)));
  years.add(curY);
  years.add(String(now.getFullYear() + 1)); // anul urmator (pt. trecerea Decembrie -> Ianuarie)
  const wm = workMonth(); const wmM = wm.slice(5); const wmY = wm.slice(0, 4);
  years.add(wmY);
  const yearOpts = [...years].sort().reverse().map((y) => `<option value="${y}">${y}</option>`).join('');
  const monthOpts = luniUi().map((n, i) => `<option value="${String(i + 1).padStart(2, '0')}">${n}</option>`).join('');
  const lunaOpts = '<option value="">' + (uiLanguage() === 'en' ? 'All months' : 'Toate lunile') + '</option>' + monthOpts;
  // implicit, toate filtrele pornesc pe LUNA DE LUCRU (poti alege „Toate lunile” oricand)
  $$('select.an').forEach((s) => { const keep = isPeriodOverrideActive(s) ? s.value : wmY; s.innerHTML = yearOpts; s.value = keep || wmY; });
  $$('select.luna').forEach((s) => { const keep = isPeriodOverrideActive(s) ? s.value : wmM; s.innerHTML = lunaOpts; s.value = keep; });
  ANNUAL_OVERRIDE_IDS.forEach((id) => { const el = $('#' + id); if (el && !isPeriodOverrideActive(el)) el.value = wmY; });
  const mvf = $('#mvfLuna'); if (mvf && !isPeriodOverrideActive(mvf)) mvf.value = wm;
  $$('.period-override').forEach(renderPeriodOverride);
  // Starea sagetii si banda de „luna inchisa" depind de META.company.lockedUntil, iar
  // setCurrentPeriod() de la incarcarea modulului a rulat inaintea lui setMeta(). fillPeriods()
  // ruleaza din init(), DUPA ce META e populata — si la fiecare schimbare de firma, care poate
  // aduce alt lockedUntil. Deci aici e locul unde starea se aduce la zi.
  setCurrentPeriod();
}

// Comutarea limbii nu reîncarcă pagina și nu pierde formularele începute. Sunt refăcute doar
// etichetele calendarelor și textele barei de perioadă, păstrând aceleași valori selectate.
document.addEventListener('contab:language', () => fillPeriods());

export { LUNI, LUNI_EN, pget, workMonth, setWorkMonth, nextMonth, prevMonth, lunaLabel, applyWorkMonth, onPeriodChange, fillPeriods, setPeriodsDeps,
  isPeriodOverrideActive, setPeriodOverrideActive, resetPeriodOverride };
// Exportate pentru testele unitare de frontend (plafonul lunii de lucru): test/frontend.mjs
export { capMonth, currentMonth, esteInchisa, poateInainte };
