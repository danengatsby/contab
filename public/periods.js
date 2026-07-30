'use strict';

// „Luna de lucru” + filtrele Luna/An ale tabelelor — extrase din app.js. applyWorkMonth
// reincarca ecranul curent prin dependinte injectate (setPeriodsDeps), ca modulul sa nu
// depinda de onTab/renderEntryLists din app.js.
import { $, $$, META } from './core.js';

const D = { renderEntryLists: null, onTab: null };
function setPeriodsDeps(d) { Object.assign(D, d); }

const LUNI = ['Ianuarie', 'Februarie', 'Martie', 'Aprilie', 'Mai', 'Iunie', 'Iulie', 'August', 'Septembrie', 'Octombrie', 'Noiembrie', 'Decembrie'];
// Compune perioada dintr-o pereche Lună+An: "YYYY-MM" daca e luna, "YYYY" daca e tot anul, "" daca nimic
function pget(prefix) {
  const a = $('#' + prefix + 'An'); const l = $('#' + prefix + 'Luna');
  const y = a ? a.value : ''; const m = l ? l.value : '';
  if (!y) return '';
  return m ? (y + '-' + m) : y;
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
function lunaLabel(m) { const [y, mo] = m.split('-').map(Number); return LUNI[mo - 1] + ' ' + y; }
// Vizualizatorul de documente in aplicatie (PDF/CSV/XML/e-Factura) a fost extras in public/viewer.js (Etapa 8).
// Afiseaza luna de lucru in bara de sus (langa firma)
function setCurrentPeriod() {
  const el = $('#currentPeriod'); if (!el) return;
  const m = workMonth();
  el.textContent = lunaLabel(m);
  // Sageata „inainte" se dezactiveaza pe luna curenta: un buton care nu face nimic la click pare
  // stricat, unul stins spune singur ca s-a ajuns la capat.
  const nx = $('#nextMonth');
  if (nx) {
    const laZi = m >= currentMonth();
    nx.disabled = laZi;
    nx.setAttribute('aria-disabled', String(laZi));
    nx.title = laZi ? 'Ești pe luna curentă — nu se poate lucra în viitor' : 'Luna următoare';
  }
}
// Aplica luna de lucru pe toate filtrele de tabel si reincarca ecranul curent
function applyWorkMonth() {
  const m = workMonth(); const mo = m.slice(5); const yr = m.slice(0, 4);
  $$('select.luna, select.luna-req').forEach((s) => { if ([...s.options].some((o) => o.value === mo)) s.value = mo; });
  $$('select.an').forEach((s) => { if ([...s.options].some((o) => o.value === yr)) s.value = yr; });
  // câmpurile anuale (situații financiare, închidere anuală, registru salarii) urmează anul de lucru
  ['stmtYear', 'yearInput', 'rsYear'].forEach((id) => { const el = $('#' + id); if (el) el.value = yr; });
  // câmpurile native de lună rămase (dacă există) urmează luna de lucru
  $$('input[type="month"].period').forEach((el) => { el.value = m; });
  if (D.renderEntryLists) D.renderEntryLists();
  const active = $('#tabs button[data-tab].active');
  if (active && D.onTab) D.onTab(active.dataset.tab);
}
setCurrentPeriod();
// Navigare luna de lucru din bara de sus
function goWorkMonth(m) { setWorkMonth(m); applyWorkMonth(); }
$('#prevMonth') && $('#prevMonth').addEventListener('click', () => goWorkMonth(prevMonth(workMonth())));
$('#nextMonth') && $('#nextMonth').addEventListener('click', () => goWorkMonth(nextMonth(workMonth())));
$('#currentPeriod') && $('#currentPeriod').addEventListener('click', () => goWorkMonth(currentMonth()));

// Leaga schimbarea perechii Lună+An de functia de reincarcare a tabelului
function onPeriodChange(prefix, fn) {
  ['Luna', 'An'].forEach((sfx) => {
    const el = $('#' + prefix + sfx);
    if (!el) return;
    el.addEventListener('change', () => {
      const p = pget(prefix);
      // o lună anume devine „luna de lucru” și sincronizează TOATE tabelele (jurnal, intrări, ieșiri…)
      if (/^\d{4}-\d{2}$/.test(p)) { setWorkMonth(p); applyWorkMonth(); }
      else { fn(); } // „Toate lunile” / an întreg: doar tabelul curent
    });
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
  const monthOpts = LUNI.map((n, i) => `<option value="${String(i + 1).padStart(2, '0')}">${n}</option>`).join('');
  const lunaOpts = '<option value="">Toate lunile</option>' + monthOpts;
  // implicit, toate filtrele pornesc pe LUNA DE LUCRU (poti alege „Toate lunile” oricand)
  $$('select.an').forEach((s) => { const keep = s.value; s.innerHTML = yearOpts; s.value = keep || wmY; });
  $$('select.luna').forEach((s) => { const keep = s.value; s.innerHTML = lunaOpts; s.value = keep || wmM; });
  // luna obligatorie (stocuri, salarizare, mijloace fixe) — fara „Toate”
  $$('select.luna-req').forEach((s) => { const keep = s.value; s.innerHTML = monthOpts; s.value = keep || wmM; });
}

export { LUNI, pget, workMonth, setWorkMonth, nextMonth, prevMonth, lunaLabel, applyWorkMonth, onPeriodChange, fillPeriods, setPeriodsDeps };
// Exportate pentru testele unitare de frontend (plafonul lunii de lucru): test/frontend.mjs
export { capMonth, currentMonth };
