'use strict';

// COCKPITUL DE INCHIDERE LUNARA: fluxul unic documente → bancă → TVA → declarații → aprobare →
// blocare, cu responsabil, termen, dovada validării și motivul blocajului.
//
// Modulul NU decide nimic: starea pașilor, blocajele și regulile de ordine vin întregi de la
// server (`GET /api/monthly-close`), ca ecranul și motorul să nu poată ajunge la păreri diferite.
// Aici e doar randare + acțiuni. Funcțiile pure de compunere a HTML-ului sunt exportate separat,
// marcate pentru test/frontend.mjs.

import { $, $$, H, api, toast, confirmAction, promptAction, plural, dataRo } from './core.js';
import { workMonth, lunaLabel } from './periods.js';

const D = { goTab: null };
function setInchidereDeps(d) { Object.assign(D, d); }

// ── Compunerea HTML-ului (pur, testabil) ──

const STARE_META = {
  gata: { pill: 'ok', icon: '✓', text: 'gata' },
  deschis: { pill: 'warn', icon: '•', text: 'de făcut' },
  blocat: { pill: 'muted', icon: '⋯', text: 'așteaptă' },
  nuseaplica: { pill: 'muted', icon: '–', text: 'nu se aplică' },
};

/** Bara de progres + verdictul lunii. */
export function closeHeaderHtml(st) {
  const p = st.progres || { gata: 0, total: 0, procent: 0 };
  const verdict = st.inchisa
    ? '<span class="pill ok">lună închisă</span>'
    : (st.sePoateInchide ? '<span class="pill ok">se poate închide</span>' : `<span class="pill warn">${plural(p.total - p.gata, 'pas', 'pași')} de rezolvat</span>`);
  const fortata = st.fortata
    ? `<div class="notice warning"><span class="notice-icon">⚠</span><div>Închidere <b>forțată</b> de ${H(st.fortata.username)} la ${H(String(st.fortata.at).slice(0, 16).replace('T', ' '))} — motiv: „${H(st.fortata.motiv)}”.
       Pași nerezolvați la acel moment: ${H((st.fortata.blocante || []).join(', '))}.</div></div>`
    : '';
  const aprobare = st.aprobare
    ? `<p class="muted">Aprobată de <b>${H(st.aprobare.username || st.aprobare.responsabil || '—')}</b> la ${H(String(st.aprobare.at).slice(0, 16).replace('T', ' '))}${st.aprobare.nota ? ' — ' + H(st.aprobare.nota) : ''}.</p>`
    : '';
  return `<div class="closehead">
    <div class="closebar" title="${p.gata} din ${p.total} pași"><span class="closebarfill" data-style="width:${p.procent}%"></span></div>
    <div class="closemeta">${verdict} <span class="muted">${p.gata}/${p.total} pași · termenul lunii: ${H(st.ancoraTermen ? dataRo(st.ancoraTermen) : '—')}</span></div>
    ${aprobare}${fortata}</div>`;
}

// Temeiul legal al pasului, pliat: cine vrea sa vada exact ce spune legea il deschide, restul
// nu-si incarca ecranul. Textul vine de la SERVER (src/temeiLegal.js) — o a doua copie in frontend
// ar drifta fata de cea din ghid si din documentatie.
function temeiHtml(temei) {
  if (!Array.isArray(temei) || !temei.length) return '';
  return `<details class="temei"><summary class="muted">Temei legal: ${
    temei.map((x) => H(x.eticheta)).join(' · ')}</summary><ul>${
    temei.map((x) => `<li><b>${H(x.actTitlu)}</b>${x.articol && x.articol !== '—' ? ', ' + H(x.articol) : ''} — ${H(x.ce)}</li>`).join('')}</ul></details>`;
}

/** Un pas: stare, blocaje (motivul), responsabil, termen, acțiune. */
export function stepHtml(s, responsabili) {
  const m = STARE_META[s.stare] || STARE_META.deschis;
  const optiuni = ['<option value="">— nealocat —</option>']
    .concat((responsabili || []).map((u) => `<option value="${H(u.id)}"${String(u.id) === String(s.responsabilId) ? ' selected' : ''}>${H(u.username)}</option>`))
    .join('');
  const blocaje = s.blocaje && s.blocaje.length
    ? `<ul class="closeblock">${s.blocaje.map((b) => `<li>${H(b)}</li>`).join('')}</ul>`
    : '';
  const blocatDe = s.blocatDe ? `<p class="muted closewait">Așteaptă pasul anterior: <b>${H(s.blocatDe)}</b>.</p>` : '';
  const motiv = s.motiv ? `<p class="muted">${H(s.motiv)}</p>` : '';
  // Campul nativ se randeaza in locale-ul BROWSERULUI (pe un sistem in engleza: 07/10/2026), iar
  // restul ecranului scrie romaneste. Data rezolvata, langa el, inlatura ambiguitatea 7 oct./10 iul.
  const termen = `<label class="closefield">Termen
      <input type="date" class="cl-due" data-step="${H(s.key)}" value="${H(s.due || '')}"${s.dueImplicit ? ' data-implicit="1"' : ''} />
      ${s.due ? `<span class="cl-due-ro">${H(dataRo(s.due))}</span>` : ''}
      ${s.overdue ? '<span class="pill err">depășit</span>' : ''}${s.dueImplicit ? '<span class="muted"> implicit</span>' : ''}</label>`;
  const resp = `<label class="closefield">Responsabil
      <select class="cl-resp" data-step="${H(s.key)}">${optiuni}</select></label>`;
  // Butonul apare doar daca pasul se rezolva pe ALT ecran; aprobarea si blocarea au butoanele
  // lor in bara de actiuni a cockpitului, deci nu-si dubleaza actiunea aici.
  const actiune = (s.stare === 'gata' || s.stare === 'nuseaplica' || !s.tab) ? ''
    : `<button class="btn cl-go" data-tab="${H(s.tab)}">${H(s.eticheta)}</button>`;
  return `<li class="closestep is-${H(s.stare)}" data-step="${H(s.key)}">
    <div class="closestep-h"><span class="closeicon">${m.icon}</span>
      <b>${H(s.nume)}</b> <span class="pill ${m.pill}">${m.text}</span></div>
    <p class="muted">${H(s.descriere)}</p>
    ${temeiHtml(s.temei)}
    ${motiv}${blocatDe}${blocaje}
    <div class="closefields">${resp}${termen}</div>
    ${s.nota ? `<p class="muted">Notă: ${H(s.nota)}</p>` : ''}
    ${actiune}</li>`;
}

// Statusurile din registrul depunerilor sunt valori interne (fără diacritice) — le arătăm
// în scriere românească, fără să atingem valorile stocate.
const STATUS_LABEL = { nedepusa: 'nedepusă', generata: 'generată', depusa: 'depusă', eroare: 'eroare', scutita: 'scutită' };
export function statusLabel(s) { return STATUS_LABEL[s] || s || '—'; }

/** Tabelul dovezilor de validare pentru declarațiile lunii. */
export function proofsHtml(st, validabile) {
  const decls = ((st.steps.find((s) => s.key === 'declaratii') || {}).detalii || {}).declaratii || [];
  if (!decls.length) return '<p class="muted">Nicio declarație așteptată pentru luna asta.</p>';
  const poateValida = new Set((validabile || []).map((x) => x.tip));
  return `<table><thead><tr><th>Declarație</th><th>Termen</th><th>Stare</th><th>Dovada validării</th><th></th></tr></thead><tbody>${
    decls.map((r) => {
      const dov = r.dovada
        ? (r.dovada.ok
          ? `<span class="pill ok">fără erori</span> <span class="muted">${H(String(r.dovada.at).slice(0, 16).replace('T', ' '))} · ${H(r.dovada.username || '')}</span>`
          : `<span class="pill err">${H(r.dovada.errors)} eroare/erori</span> <span class="muted">${H(String(r.dovada.at).slice(0, 16).replace('T', ' '))}</span>`)
        : '<span class="muted">nevalidată</span>';
      return `<tr><td>${H(r.nume)}</td><td>${H(r.due)}${r.overdue ? ' <span class="pill err">depășit</span>' : ''}</td>
        <td>${H(statusLabel(r.status))}</td><td>${dov}</td>
        <td>${poateValida.has(r.tip) ? `<button class="linkbtn cl-val" data-tip="${H(r.tip)}">validează</button>` : ''}</td></tr>`;
    }).join('')}</tbody></table>`;
}

// ── Randare + acțiuni ──


function period() { return workMonth(); }

async function loadMonthlyClose() {
  const host = $('#closeCockpit');
  if (!host) return;
  const per = period();
  const t = $('#closePeriodLabel'); if (t) t.textContent = lunaLabel(per);
  let st;
  try { st = await api('/api/monthly-close?period=' + encodeURIComponent(per)); }
  catch (e) { host.innerHTML = `<p class="muted">${H(e.message)}</p>`; return; }
  host.innerHTML = closeHeaderHtml(st)
    + `<ol class="closesteps">${st.steps.map((s) => stepHtml(s, st.responsabili)).join('')}</ol>`;
  const pr = $('#closeProofs'); if (pr) pr.innerHTML = proofsHtml(st, st.validabile);
  wire();
  renderCloseButton(st);
}

function renderCloseButton(st) {
  const box = $('#closeAction');
  if (!box) return;
  if (st.finalizata) {
    const c = st.inchidere || {};
    box.innerHTML = `<p class="ok">🔒 Luna ${H(st.period)} este închisă${c.username ? ' de ' + H(c.username) : ''}${c.at ? ' la ' + H(String(c.at).slice(0, 16).replace('T', ' ')) : ''} — perioada e read-only. Deblocarea se face din Setări → Blocare perioadă.</p>`;
    return;
  }
  const aprobata = !!st.aprobare;
  const blocante = st.blocante || [];
  // Perioada poate fi deja blocată fără să fi trecut prin flux (marcarea unei declarații ca
  // depusă blochează automat luna). Spunem asta, ca butonul „Blochează perioada" să nu pară inutil.
  const dejaBlocata = st.inchisa
    ? `<p class="muted">Perioada e deja blocată (${H(st.lockedUntil)}) — probabil de la marcarea unei declarații ca depusă. Închiderea de aici consemnează dosarul lunii.</p>`
    : '';
  box.innerHTML = dejaBlocata + `
    ${aprobata
    ? '<button id="clUnapprove" class="btn">Retrage aprobarea</button>'
    : '<button id="clApprove" class="btn primary">Aprobă luna</button>'}
    <button id="clClose" class="btn primary"${blocante.length ? ' disabled' : ''}>Blochează perioada</button>
    ${blocante.length
    ? `<p class="muted">Închiderea e blocată de: ${H(blocante.map((b) => b.nume).join(', '))}.</p>
       <button id="clForce" class="linkbtn">Forțează închiderea (administrator)…</button>`
    : ''}`;
  $('#clApprove') && $('#clApprove').addEventListener('click', async () => {
    try { await api('/api/monthly-close/approve', post({ period: st.period, nota: '' })); toast('Luna a fost aprobată.'); loadMonthlyClose(); }
    catch (e) { toast(e.message, true); }
  });
  $('#clUnapprove') && $('#clUnapprove').addEventListener('click', async () => {
    try { await api('/api/monthly-close/unapprove', post({ period: st.period })); toast('Aprobare retrasă.'); loadMonthlyClose(); }
    catch (e) { toast(e.message, true); }
  });
  $('#clClose') && $('#clClose').addEventListener('click', async () => {
    if (!await confirmAction('Perioada ' + st.period + ' va deveni numai pentru citire. Corecțiile ulterioare se fac prin storno.', {
      title: 'Blochezi perioada?', confirmLabel: 'Blochează perioada', danger: true,
    })) return;
    try { await api('/api/monthly-close/close', post({ period: st.period })); toast('Perioada ' + st.period + ' a fost blocată.'); loadMonthlyClose(); }
    catch (e) { toast(e.message, true); }
  });
  $('#clForce') && $('#clForce').addEventListener('click', async () => {
    const motiv = await promptAction('Perioada va fi închisă peste pași nerezolvați. Motivul rămâne în dosarul lunii și în jurnalul de audit.', {
      title: 'Forțezi închiderea?', label: 'Motivul excepției', multiline: true, required: true, minLength: 10,
      confirmLabel: 'Închide forțat', danger: true,
    });
    if (motiv == null) return;
    try { await api('/api/monthly-close/close', post({ period: st.period, force: true, motiv })); toast('Perioadă închisă forțat — motivul a fost consemnat.'); loadMonthlyClose(); }
    catch (e) { toast(e.message, true); }
  });
}

function post(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function saveStep(step, patch) {
  try {
    await api('/api/monthly-close/step', post(Object.assign({ period: period(), step }, patch)));
    loadMonthlyClose();
  } catch (e) { toast(e.message, true); }
}

function wire() {
  $$('#closeCockpit .cl-resp').forEach((el) => el.addEventListener('change', () => saveStep(el.dataset.step, { responsabilId: el.value || null })));
  $$('#closeCockpit .cl-due').forEach((el) => el.addEventListener('change', () => saveStep(el.dataset.step, { due: el.value || null })));
  $$('#closeCockpit .cl-go').forEach((b) => b.addEventListener('click', () => { if (D.goTab) D.goTab(b.dataset.tab); }));
  $$('#closeProofs .cl-val').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api('/api/monthly-close/validate', post({ period: period(), tip: b.dataset.tip }));
      toast(r.rezultat.ok ? 'Validare fără erori — dovada a fost salvată.' : (r.rezultat.errors.length + ' eroare/erori — vezi detaliile.'), !r.rezultat.ok);
      loadMonthlyClose();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }));
}

export { loadMonthlyClose, setInchidereDeps };
