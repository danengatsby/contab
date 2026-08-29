'use strict';

// Declaratii & termene: livrabile ANAF, registrul depunerilor, fisa rol/SPV, portofoliu, notificari, reconciliere, scadentar. Extras din app.js (Etapa: spargerea fisierului mare).
import { $$, $, H, fmt, accName, toast, api, ac, confirmAction, promptAction, dataRo } from './core.js';
import { pget, onPeriodChange } from './periods.js';
import { loadEntries } from './entries.js'; // apelat mai jos; fara import = ReferenceError
import { registerFormFlow, formFlowFlush, formFlowLoaded, formFlowSaved } from './formflow.js';

// Dependinte injectate din app.js (navigare, schimbarea firmei, luna de lucru) — livrabile.js nu
// importa inapoi din app.js. Vezi setLivrabileDeps in app.js.
let D = {};
export function setLivrabileDeps(d) { D = d; }

// ───────────────────────── LIVRABILE ─────────────────────────
onPeriodChange('livrabile', loadLivrabile);
// Starea unui livrabil, spusa in doua feluri: `t` = eticheta de breasla (cea de pana acum), `ts` =
// ce inseamna ea pentru cineva care nu e contabil. „recap (→ ANAF)" nu spune NIMIC unui patron —
// si tocmai el se uita in aceasta lista ca sa afle ce are de facut luna asta. Semnificatiile sunt
// cele din antetul lui `livrabile()` (src/reporting.js), nu inventate aici.
const STATUS = {
  ok: { t: 'disponibil', ts: 'gata, îl poți descărca', c: 'var(--accent)', bg: '#eef6f2' },
  recap: { t: 'recap (→ ANAF)', ts: 'se depune la ANAF', c: '#8a6d00', bg: '#fdf6e3' },
  regim: { t: 'după regim', ts: 'doar dacă e cazul firmei tale', c: '#5a4', bg: '#eef6f2' },
  anaf: { t: 'emis de ANAF', ts: 'îl emite ANAF, nu tu', c: '#6b7280', bg: '#eef1f7' },
  manual: { t: 'pregătit de firmă', ts: 'îl faci tu, în afara aplicației', c: '#6b7280', bg: '#eef1f7' },
};
/** Eticheta de stare, in ambele variante: CSS alege care se vede (`.adv` / `.simple-only-inline`).
 *  Functie pura, exportata pentru test/frontend.mjs — un `ts` uitat la o stare noua ar lasa modul
 *  simplu cu eticheta goala, iar in modul expert n-ar avea cum sa se vada. */
export function statusLabel(st) {
  const x = STATUS[st] || STATUS.manual;
  return `<span class="adv">${x.t}</span><span class="simple-only-inline">${x.ts}</span>`;
}
function updateF4109Link() {
  const a = $('#f4109Pdf'); if (!a) return;
  const p = pget('livrabile') || new Date().toISOString().slice(0, 7);
  const serie = encodeURIComponent(($('#f4109Serie') && $('#f4109Serie').value.trim()) || '');
  a.href = '/pdf/f4109?period=' + p + (serie ? '&serie=' + serie : '');
}
$('#f4109Serie') && $('#f4109Serie').addEventListener('input', updateF4109Link);
async function loadLivrabile() {
  const p = pget('livrabile') || new Date().toISOString().slice(0, 7);
  updateF4109Link();
  const data = await api('/api/livrabile?period=' + p);
  const s = data.sumar;
  const de = s.d300.deplata > 0 ? ['TVA de plată', s.d300.deplata] : ['TVA de recuperat', s.d300.derecuperat];
  // Cele doua carduri au fost o sursa de contradictie aparenta: „Impozit micro 146,00" in stanga,
  // „TOTAL 0,00" in dreapta, pentru aceeasi luna, la trei centimetri distanta. Amandoua corecte —
  // stanga CALCULEAZA din declaratii (iar impozitul micro e pe TRIMESTRU, nu pe luna), dreapta
  // aduna taxele inregistrate efectiv ca datorate in luna. Nimic nu spunea asta, deci se scrie.
  const trimLuni = (s.d100.luni || []).length === 3 ? ' (' + s.d100.luni[0] + '…' + s.d100.luni[2] + ')' : '';
  $('#livrabileSumar').innerHTML =
    `<div class="card"><h3>Ce rezultă din declarații — ${H(p)}</h3>
     <p class="muted">Sume <b>calculate</b> din ce ai înregistrat. Unele acoperă alt interval decât luna aleasă — scrie pe fiecare rând.</p>
     <table>
      <tr><td>Salarii brute <span class="muted">· luna ${H(p)}</span>${s.d112.postat ? '' : ' <span class="pill warn">ciornă</span>'}</td><td class="num">${fmt(s.d112.brut)}</td></tr>
      <tr><td>Total de virat (D112) <span class="muted">· luna ${H(p)}</span>${s.d112.postat ? '' : ' <span class="pill warn">nepostat</span>'}</td><td class="num">${fmt(s.d112.totalBuget)}</td></tr>
      <tr><td>${de[0]} (D300) <span class="muted">· luna ${H(p)}</span></td><td class="num">${fmt(de[1])}</td></tr>
      ${s.du
    ? `<tr><td>Taxe PFA — Declarația Unică <span class="muted">· estimare pe tot anul</span></td><td class="num">${fmt(s.du.total)}</td></tr>`
    : `<tr><td>Impozit micro ${s.d100.cota || 1}% (D100) <span class="muted">· pe <b>trimestrul ${H(s.d100.trimestru || '')}</b>${H(trimLuni)}, nu pe luna</span></td><td class="num">${fmt(s.d100.impozit)}</td></tr>`}
     </table>
     ${!s.du && (s.d100.avertismente || []).length
    ? `<div class="notice warning" data-u="u23"><span class="notice-icon">⚠️</span><div><b>Eligibilitate micro:</b> ${s.d100.avertismente.join('<br>')}</div></div>`
    : ''}</div>
     <div class="card"><h3>Taxe devenite datorate în ${H(p)}</h3>
      <p class="muted">Ce s-a <b>înregistrat</b> ca datorie către stat chiar în luna aceasta.</p>
      <p class="muted adv">Rulajul creditor al conturilor de taxe pe perioada aleasă — nu soldul cumulat.</p>
      <table>
      ${s.obligatii.items.map((i) => `<tr><td><span class="adv">${H(i.cont)}</span> ${H(i.nume)}</td><td class="num">${fmt(i.suma)}</td></tr>`).join('')
    || '<tr><td class="muted">—</td><td></td></tr>'}
      <tr class="total"><td>TOTAL</td><td class="num">${fmt(s.obligatii.total)}</td></tr>
     </table>
     ${s.obligatii.items.length ? '' : `<p class="muted">Nicio taxă înregistrată ca datorată în ${H(p)}. Sumele din stânga sunt <b>calculate</b> din declarații — devin datorii aici când înregistrezi statul de plată sau închiderea de TVA. Deci e normal ca cele două carduri să nu se potrivească.</p>`}
     </div>`;
  $('#livrabileLegend').innerHTML = Object.keys(STATUS).map((k) =>
    `<span data-u="u146"><b data-style="color:${STATUS[k].c}">●</b> ${statusLabel(k)}</span>`).join('');
  const badge = (st) => { const x = STATUS[st] || STATUS.manual; return `<span data-style="background:${x.bg};color:${x.c};border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;white-space:nowrap">${statusLabel(st)}</span>`; };
  let sec = '';
  const rows = data.list.map((it) => {
    const head = it.sectiune !== sec ? (sec = it.sectiune, `<tr><td colspan="4" data-u="u147">${it.sectiune}</td></tr>`) : '';
    const links = it.links.map((l) => `<a class="linkbtn" href="${l.href}" target="_blank">${l.label}</a>`).join(' · ') || '<span class="muted">—</span>';
    // `obs` vine de la server (src/reporting.js) si e nota TEHNICA a randului: „XML de validat cu
    // DUKIntegrator", „Depunerea XML + recipisa la ANAF". Deci `.adv` — in modul simplu intelesul
    // il duce deja eticheta de stare, in cuvintele omului („se depune la ANAF", „doar daca e cazul
    // firmei tale"). Fara asta, jargonul intra in pagina pe alta usa decat index.html.
    return head + `<tr><td>${it.nr}</td><td>${H(it.nume)}${it.obs ? `<br><span class="muted adv" data-u="u148">${H(it.obs)}</span>` : ''}</td><td>${badge(it.status)}</td><td>${links}</td></tr>`;
  }).join('');
  $('#livrabileList').innerHTML = `<table><thead><tr><th>#</th><th>Document / declarație</th><th>Statut</th><th>Descărcare</th></tr></thead><tbody>${rows}</tbody></table>`;
  loadDeclRegister(p);
}

// ───────────────────────── REGISTRUL DEPUNERILOR ─────────────────────────
const DECL_ST = {
  nedepusa: { t: 'Nedepusă', c: '#b26a00', bg: '#fff4e0' },
  generata: { t: 'Generată', c: '#1652d6', bg: '#e7eefc' },
  aprobata: { t: 'Aprobată', c: '#4f6f12', bg: '#eef6dd' },
  transmisa: { t: 'Transmisă', c: '#6b46c1', bg: '#f0e9ff' },
  depusa: { t: 'Depusă', c: '#0a7d33', bg: '#e2f5e8' },
  eroare: { t: 'Eroare', c: '#b00020', bg: '#fde7ea' },
  scutita: { t: 'Scutită', c: '#5a6472', bg: '#eceff3' },
  netrimisa: { t: 'Netrimisă în SPV', c: '#b00020', bg: '#fde7ea' },
};
const DECL_NEXT = {
  nedepusa: ['generata', 'scutita'], generata: ['aprobata', 'eroare', 'scutita'],
  aprobata: ['transmisa', 'eroare', 'scutita'],
  transmisa: ['depusa', 'eroare'], eroare: ['generata'], depusa: [], scutita: [],
};
function chooseFilingProof() {
  return new Promise((resolve) => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.xml,.zip,.pdf';
    let settled = false;
    const finish = (file) => { if (settled) return; settled = true; resolve(file || null); };
    input.addEventListener('change', () => finish(input.files && input.files[0]));
    input.addEventListener('cancel', () => finish(null));
    window.addEventListener('focus', () => setTimeout(() => {
      if (!settled && !(input.files && input.files.length)) finish(null);
    }, 300), { once: true });
    input.click();
  });
}
// Sensul inregistrarii de provizion depinde de SEMN: se CONSTITUIE cand mai e nevoie de
// provizion (6814 = 491) si se RELUA cand cel existent e prea mare (491 = 7814). O inversare
// aici arata contabilului exact articolul invers fata de cel corect.
const provizionDirectie = (deAjustat) => ((Number(deAjustat) || 0) >= 0 ? '6814 = 491' : '491 = 7814, reluare');
// Cele TREI stari fata de termen, pentru declaratiile inca nedepuse. Distinctia exista de mult in
// aplicatie, dar doar pe ecranul de notificari; aici, „termen peste 43 de zile, nicio operatiune in
// luna" si „termenul a trecut ieri" se afisau IDENTIC: „Nedepusă", pe fond de avertizare. Pentru o
// firma inscrisa acum un minut, trei randuri asa citesc ca un repros, nu ca o informatie — si
// tocesc semnalul exact acolo unde el trebuie sa insemne „ai o problema ACUM".
const DECL_URG = {
  'in-pregatire': { t: 'În pregătire', c: '#5a6472', bg: '#eceff3' },
  termen: { t: 'De depus', c: '#b26a00', bg: '#fff4e0' },
  restanta: { t: 'Restanță', c: '#b00020', bg: '#fde7ea' },
};
/**
 * Eticheta afisata pentru o declaratie: starea SALVATA, cand exista una, altfel pozitia fata de
 * termen. Functie PURA (testata in test/frontend.mjs).
 *
 * „Nedepusă" e adevarat, dar nu spune nimic: ORICE declaratie e nedepusa pana e depusa. Informatia
 * utila e alta — mai ai timp, e momentul, sau ai intarziat. Starea salvata ramane `nedepusa` (si
 * asa apare in selectorul „Schimbă starea"); doar eticheta se deriva, iar `titlu` explica asta,
 * ca sa nu para ca sunt doua sisteme de stari.
 */
export function declStareAfisata(status, urgenta) {
  const u = DECL_URG[urgenta];
  if ((status || 'nedepusa') === 'nedepusa' && u) {
    return Object.assign({}, u, {
      titlu: urgenta === 'restanta'
        ? 'Termenul a trecut, iar declarația nu e marcată ca depusă.'
        : (urgenta === 'termen'
          ? 'Termenul se apropie — pregătește depunerea.'
          : 'Nimic de făcut încă: termenul e mai departe de o săptămână. Starea salvată rămâne „nedepusă".'),
    });
  }
  const x = DECL_ST[status] || DECL_ST.nedepusa;
  return Object.assign({}, x, { titlu: '', restanta: urgenta === 'restanta' });
}
const declBadge = (st, urgenta) => {
  const x = declStareAfisata(st, urgenta);
  return `<span title="${H(x.titlu || '')}" data-style="background:${x.bg};color:${x.c};border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;white-space:nowrap">${H(x.t)}</span>`
    + (x.restanta ? ' <span data-u="u149">⏰ restanță</span>' : '');
};

const DOSSIER_EVENT_NAMES = {
  'dossier.created': 'Dosar creat', 'legacy.snapshot': 'Stare istorică sigilată',
  'artifact.generated': 'Artefact generat', 'approval.recorded': 'Document aprobat',
  'status.transmisa': 'Transmitere confirmată', 'status.depusa': 'Depunere confirmată',
  'status.eroare': 'Eroare consemnată', 'status.scutita': 'Scutire consemnată',
  'status.generata': 'Revenire la starea generată', 'submission.recorded': 'Depunerea inițială arhivată',
  'submission.amended': 'Rectificativă arhivată', 'receipt.attached': 'Recipisă suplimentară',
  'submitted-artifact.attached': 'Original depus atașat',
  'submitted-artifact.corrected': 'Original depus corectat',
  'status.evidence-updated': 'Dovadă actualizată',
};
const PROFILE_FIELD_NAMES = {
  tipEntitate: 'tip entitate', tvaPlatitor: 'plătitor TVA', tvaArt317: 'cod TVA art. 317',
  tvaLaIncasare: 'TVA la încasare', tvaCodAnulat: 'cod TVA anulat', dataAnulareTva: 'data anulării TVA',
  motivAnulareTva: 'motiv anulare TVA', dataReinregistrareTva: 'data reînregistrării TVA',
  perioadaTva: 'perioada TVA', regimImpozit: 'regim de impozitare', d406Cadenta: 'cadență D406',
  intrastatObligat: 'obligație Intrastat', scutiri: 'scutiri', sistemProfit: 'sistem impozit pe profit',
  anticipatProfitContabil: 'avans pe profit contabil',
};
function timelineMoment(value) {
  const raw = String(value || '');
  if (!raw) return 'moment neînregistrat';
  return dataRo(raw.slice(0, 10)) + (raw.includes('T') ? ' · ' + raw.slice(11, 16) + ' UTC' : '');
}
function timelineValue(value) {
  if (value === true) return 'da';
  if (value === false) return 'nu';
  if (value == null || value === '') return '—';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key]);
    return keys.length ? keys.join(', ') : 'niciuna';
  }
  return String(value);
}
function timelineProof(label, value) {
  const hash = String(value || '');
  return hash ? `${H(label)} <code title="${H(hash)}">${H(hash.slice(0, 12))}…</code>` : '';
}
function fiscalProfileSummary(values) {
  const v = values || {};
  const regim = v.regimImpozit || (v.tipEntitate === 'pfa' ? 'PFA' : 'micro');
  const tva = v.tvaCodAnulat ? 'cod TVA anulat' : (v.tvaPlatitor
    ? 'TVA ' + (v.perioadaTva === 'T' ? 'trimestrial' : 'lunar') : (v.tvaArt317 ? 'TVA art. 317' : 'neplătitor TVA'));
  return `${regim} · ${tva} · D406 ${v.d406Cadenta || 'automat'}`;
}

/** Randare pură a proiecției server-side. Ordinea primită este deja ordinea auditabilă; interfața
 * nu sortează după validFrom și nu confundă efectul fiscal cu momentul consemnării. */
export function renderDossierTimeline(timeline) {
  const rows = Array.isArray(timeline) ? timeline : [];
  if (!rows.length) return '<p class="muted">Cronologia va apărea la primul eveniment al dosarului.</p>';
  return `<ol class="dossier-timeline">${rows.map((item) => {
    if (item.kind === 'fiscal-profile') {
      const changes = (item.changes || []).map((change) => `<li><b>${H(PROFILE_FIELD_NAMES[change.field] || change.field)}</b>: ${H(timelineValue(change.before))} → ${H(timelineValue(change.after))}</li>`).join('');
      const uses = (item.uses || []).filter((use) => use.kind === 'submission').map((use) => '#' + use.ordinal).join(', ');
      const badges = (item.appliesToPeriod ? '<span class="pill ok">aplicabil perioadei</span>' : '')
        + (item.usedByDossier ? '<span class="pill">folosit în dosar</span>' : '');
      return `<li class="timeline-item profile-change"><div class="timeline-head"><span class="timeline-kind">Profil fiscal</span><b>${item.eventType === 'profile.baseline' ? 'Fotografie fiscală inițială' : 'Schimbare de profil fiscal'}</b><time>${H(timelineMoment(item.occurredAt))}</time></div>
        <div class="timeline-body">${badges}<p><b>Profil:</b> ${H(fiscalProfileSummary(item.values))}</p><p><b>Efectiv:</b> ${H(dataRo(item.effectiveAt))} → ${item.validTo ? H(dataRo(item.validTo)) + ' (exclusiv)' : 'prezent'}${uses ? ' · depuneri ' + H(uses) : ''}</p>
        ${changes ? `<ul class="profile-changes">${changes}</ul>` : ''}${item.note ? `<p>Motiv: ${H(item.note)}</p>` : ''}
        <p class="muted">Revizie <code>${H(item.revisionId || 'fără identificator')}</code></p></div></li>`;
    }
    const title = DOSSIER_EVENT_NAMES[item.eventType] || item.eventType || 'Eveniment dosar';
    const actor = item.actor && (item.actor.username || item.actor.actorId);
    const transition = item.from && item.to && item.from !== item.to
      ? `<span class="timeline-transition">${H(item.from)} → ${H(item.to)}</span>` : '';
    const ordinal = item.ordinal ? ` <span class="pill">#${H(item.ordinal)}${item.rectificativa ? ' · rectificativă' : ' · inițială'}</span>` : '';
    const receipts = (item.receiptReferences || []).length
      ? `<p>Recipisă: <b>${item.receiptReferences.map((reference) => H(reference)).join(', ')}</b></p>` : '';
    const proofs = [timelineProof('eveniment', item.eventHash), timelineProof('depunere', item.submissionHash),
      timelineProof('document', item.artifactHash), timelineProof('aprobare', item.approvalHash),
      ...(item.receiptHashes || []).map((hash) => timelineProof('recipisă', hash))].filter(Boolean).join(' · ');
    return `<li class="timeline-item filing-event"><div class="timeline-head"><span class="timeline-kind">Dosar #${H(item.sequence || '—')}</span><b>${H(title)}</b><time>${H(timelineMoment(item.occurredAt))}</time></div>
      <div class="timeline-body">${transition}${ordinal}${actor ? `<p>Actor: <b>${H(actor)}</b></p>` : ''}${item.reason ? `<p>Motiv: ${H(item.reason)}</p>` : ''}${receipts}${proofs ? `<p class="muted timeline-proofs">${proofs}</p>` : ''}</div></li>`;
  }).join('')}</ol>`;
}
async function loadDeclRegister(p) {
  const box = $('#declRegister'); if (!box) return;
  const eticheta = $('#declRegisterLuna'); if (eticheta) eticheta.textContent = p || '';
  const data = await api('/api/declarations?period=' + p);
  if (!data.rows.length) { box.innerHTML = '<p class="muted">Nicio declarație de depus pe această lună — firma nu datorează niciuna (fără TVA, fără angajați).</p>'; return; }
  const review = data.fiscalReview || {};
  const reviewReady = !!review.ready;
  const opts = (cur) => Object.keys(DECL_ST).filter((k) => k !== 'netrimisa').map((k) => {
    const transitionAllowed = k === cur || (DECL_NEXT[cur] || []).includes(k);
    const reviewBlocked = !reviewReady && ['transmisa', 'depusa'].includes(k) && k !== cur;
    const approvalOnly = k === 'aprobata' && k !== cur;
    return `<option value="${k}" ${k === cur ? 'selected' : ''} ${!transitionAllowed || reviewBlocked || approvalOnly ? 'disabled' : ''}>${DECL_ST[k].t}</option>`;
  }).join('');
  // Coloana de descarcare face randul de sine statator: pana acum spunea „D300 — nedepusa, termen
  // 25.09" si te trimitea sa cauti fisierul in catalogul de 25 de randuri. Linkurile vin de la
  // server (src/declarations.js `DESCARCARI`), ca sa nu existe o a doua lista de rute in frontend.
  const reviewBanner = reviewReady
    ? `<div class="notice success"><span class="notice-icon">✓</span><div><b>Revizie fiscală externă validă:</b> ${H(review.approved)}/${H(review.total)} cazuri aprobate pentru setul ${H(review.fiscalYear)}.</div></div>`
    : `<div class="notice warning"><span class="notice-icon">🔒</span><div><b>Artefactele de depunere sunt blocate:</b> ${H(review.approved || 0)}/${H(review.total || 0)} cazuri au aprobare externă validă${review.invalid ? `; ${H(review.invalid)} aprobări au fost invalidate după schimbarea regulilor/codului` : ''}. Poți verifica rapoartele și validarea internă; aplicația rămâne asistent contabil cu validare umană, nu garanție fiscală.</div></div>`;
  box.innerHTML = reviewBanner + `<table><thead><tr><th>Declarație</th><th>Termen</th><th>Stare</th><th>Descarcă</th><th>Schimbă starea</th><th>Dosar / cronologie</th></tr></thead><tbody>${
    data.rows.map((r) => {
      const artifacts = r.artifacts || [];
      const dossier = r.dossier || {};
      const dossierId = String(dossier.id || '');
      const dossierShort = dossierId ? dossierId.slice(0, 15) + '…' : 'identitate indisponibilă';
      const dossierState = (dossier.integrity || {}).state || 'incomplet';
      const chainShort = dossier.stateChainHash ? dossier.stateChainHash.slice(0, 12) + '…' : '—';
      const approval = r.documentApproval || null;
      const transmittedHash = String(r.transmittedArtifactHash || '');
      const approvalMatches = !!(approval && approval.artifactHash === r.artifactHash);
      const canApproveDocument = ['generata', 'depusa'].includes(r.status) && !!r.artifactHash;
      const approvalProof = approvalMatches
        ? `<p class="muted">Aprobat de <b>${H((approval.approvedBy || {}).username || (approval.approvedBy || {}).actorId || '—')}</b>
          la ${H(String(approval.approvedAt || '').slice(0, 16).replace('T', ' '))} UTC<br>
          document <code title="${H(approval.artifactHash)}">${H(approval.artifactHash)}</code><br>
          dovadă aprobare <code title="${H(approval.approvalHash)}">${H(String(approval.approvalHash || '').slice(0, 16))}…</code>${transmittedHash
    ? `<br>sigilat pentru transmitere <code title="${H(transmittedHash)}">${H(transmittedHash)}</code>` : ''}</p>`
        : (canApproveDocument ? `<button class="btn small decl-approve" data-tip="${H(r.tip)}" data-period="${H(r.period)}" data-dossier-id="${H(dossierId)}" data-artifact-hash="${H(r.artifactHash)}">Aprobă documentul exact</button>` : '');
      const dossierIntro = `<p class="muted dossier-identity">Identitate unică <code title="${H(dossierId)}">${H(dossierShort)}</code> · cheie ${H(dossier.key || '')} · ${dossier.persisted ? 'persistent' : 'rezervat până la prima generare'} · integritate ${H(dossierState)} · lanț <code title="${H(dossier.stateChainHash || '')}">${H(chainShort)}</code></p>`;
      const eventTimeline = renderDossierTimeline(r.timeline || []);
      const submissionsTable = (r.depuneri || []).length ? `<table><thead><tr><th>Versiune</th><th>Fișier depus</th><th>Recipisă</th><th>Integritate</th></tr></thead><tbody>${
  r.depuneri.slice().reverse().map((dep) => {
    const submittedHash = dep.submittedArtifactHash || dep.artifactHash || '';
    const generatedHash = dep.generatedArtifactHash || dep.artifactHash || '';
    const submitted = artifacts.find((a) => a.sha256 === submittedHash);
    const generated = artifacts.find((a) => a.sha256 === generatedHash);
    const receipts = dep.receipts || [];
    const query = `tip=${encodeURIComponent(r.tip)}&period=${encodeURIComponent(r.period)}&dossierId=${encodeURIComponent(dossierId)}&ordinal=${encodeURIComponent(dep.ordinal)}`;
    const filedDownload = submitted && submitted.contentStored
      ? `<a class="linkbtn" href="/api/declarations/artifact-file?${query}&variant=submitted">descarcă originalul</a>`
      : '<span class="pill err">lipsește binarul</span>';
    const generatedDownload = generatedHash && generatedHash !== submittedHash && generated && generated.contentStored
      ? `<br><a class="linkbtn" href="/api/declarations/artifact-file?${query}&variant=generated">descarcă varianta generată</a>` : '';
    const receiptDownloads = receipts.map((receipt, index) => receipt.contentStored
      ? `<a class="linkbtn" title="${H(receipt.receiptBindingHash || '')}" href="/api/declarations/recipisa-file?${query}&sha256=${encodeURIComponent(receipt.sha256)}">recipisa ${index + 1}${receipt.receiptBindingHash ? ' · legată' : ''}</a>`
      : `<span class="pill err">recipisa ${index + 1} fără binar</span>`).join(' · ');
    const artifactOk = !!(submitted && submitted.contentStored);
    const receiptsOk = !dep.recipisa || (receipts.length > 0 && receipts.every((receipt) => receipt.contentStored));
    const receiptBindingsOk = !dep.submissionId || receipts.every((receipt) => receipt.receiptBindingHash
      && receipt.filingBinding && receipt.filingBinding.submissionId === dep.submissionId
      && receipt.filingBinding.submissionHash === dep.submissionHash);
    const complete = artifactOk && receiptsOk && receiptBindingsOk;
    const approvedHash = dep.approvedArtifactHash || (dep.documentApproval || {}).artifactHash || '';
    const approvalLink = approvedHash
      ? `<br><span class="muted" title="${H(approvedHash)}">aprobat SHA-256 ${H(approvedHash.slice(0, 12))}…</span>` : '';
    const approvalMismatch = approvedHash && approvedHash !== submittedHash
      ? '<br><span class="pill warn">fișierul transmis diferă de cel aprobat</span>' : '';
    const submissionProof = dep.submissionId
      ? `<br><span class="muted" title="${H(dep.submissionHash || '')}">ancoră ${H(dep.submissionId.slice(0, 15))}… · SHA-256 ${H(String(dep.submissionHash || '').slice(0, 12))}…</span>` : '';
    const bindingWarning = !receiptBindingsOk ? '<br><span class="pill err">recipisă legată de altă depunere</span>' : '';
    return `<tr><td><b>#${H(dep.ordinal)}</b>${dep.rectificativa ? ' · rectificativă' : ' · inițială'}<br><span class="muted">${H(dataRo(String(dep.ts || '').slice(0, 10)))}</span>${submissionProof}${dep.motiv ? '<br>' + H(dep.motiv) : ''}</td>
      <td>${filedDownload}${generatedDownload}<br><span class="muted" title="${H(submittedHash)}">SHA-256 ${H(submittedHash.slice(0, 12))}…</span>${approvalLink}${approvalMismatch}<br><label class="linkbtn">${artifactOk ? 'corectează originalul' : 'atașează originalul'}<input class="decl-artifact hidden" type="file" accept=".xml,.zip,.pdf" data-tip="${H(r.tip)}" data-period="${H(r.period)}" data-dossier-id="${H(dossierId)}" data-ordinal="${H(dep.ordinal)}"></label></td>
      <td>${dep.recipisa ? 'nr. ' + H(dep.recipisa) : '<span class="muted">fără număr</span>'}${receiptDownloads ? '<br>' + receiptDownloads : ''}${bindingWarning}<br><label class="linkbtn">${receipts.length ? 'adaugă altă recipisă' : 'atașează recipisa'}<input class="decl-receipt hidden" type="file" accept=".xml,.zip,.pdf" data-tip="${H(r.tip)}" data-period="${H(r.period)}" data-dossier-id="${H(dossierId)}" data-ordinal="${H(dep.ordinal)}"></label></td>
      <td>${complete ? '<span class="pill ok">✓ completă</span>' : '<span class="pill warn">incompletă</span>'}</td></tr>`;
  }).join('')}</tbody></table>` : '<p class="muted">Nicio depunere confirmată încă. Documentele și recipisele vor rămâne în acest dosar.</p>';
      const archive = `<details class="decl-archive"><summary>Dosar de depunere · ${H(dossierShort)} · ${H(dossier.eventCount || 0)} evenimente sigilate · ${H((r.depuneri || []).length)} depuneri</summary>${dossierIntro}<details class="dossier-timeline-wrap"><summary>Cronologie completă · profil, document și depuneri</summary><p class="muted timeline-intro">În ordine de consemnare, de la vechi la nou. Pentru profilul fiscal, data efectivă este afișată separat.</p>${eventTimeline}</details>${submissionsTable}</details>`;
      return `<tr>
      <td>${H(r.nume)}</td>
      <td class="${r.overdue ? '' : 'muted'}" ${r.overdue ? 'data-u="u33"' : ''}>${H(dataRo(r.due))}</td>
      <td>${declBadge(r.status, r.urgenta)}</td>
      <td>${(r.links || []).map((l) => !reviewReady && /XML/i.test(l.label)
    ? `<span class="linkbtn muted" aria-disabled="true" title="Blocat până la revizia fiscală externă">🔒 ${H(l.label)}</span>`
    : `<a class="linkbtn" href="${H(l.href)}" target="_blank">${H(l.label)}</a>`).join(' · ') || (r.blocaj ? '<span class="muted">' + H(r.blocaj) + '</span>' : '<span class="muted">—</span>')}</td>
      <td><select class="decl-set" data-tip="${r.tip}" data-period="${r.period}" data-dossier-id="${H(dossierId)}" aria-label="Schimbă starea pentru ${H(r.nume)}, perioada ${H(r.period)}">${opts(r.status)}</select></td>
      <td class="muted" data-u="u148">${r.recipisa ? 'recipisă: ' + H(r.recipisa) + '<br>' : ''}${r.submittedAt ? 'depusă: ' + H(dataRo(r.submittedAt.slice(0, 10))) : (r.transmittedAt ? 'transmisă: ' + H(dataRo(r.transmittedAt.slice(0, 10))) : (r.generatedAt ? 'XML generat: ' + H(dataRo(r.generatedAt.slice(0, 10))) : ''))}<div class="adv">${r.artifactHash ? 'SHA-256: ' + H(r.artifactHash.slice(0, 12)) + '…' : ''}${approvalProof}${(r.artifacts || []).length > 1 ? '<br>artefacte păstrate: ' + H(r.artifacts.length) : ''}${(r.statusHistory || []).length ? '<br>tranziții în istoric: ' + H(r.statusHistory.length) : ''}</div>${r.note ? '<br>' + H(r.note) : ''}${archive}</td>
    </tr>`;
    }).join('')}</tbody></table>`;
  box.querySelectorAll('.decl-set').forEach((sel) => sel.addEventListener('change', async () => {
    const body = { tip: sel.dataset.tip, period: sel.dataset.period, dossierId: sel.dataset.dossierId, status: sel.value };
    if (sel.value === 'depusa') {
      const v = await promptAction('Starea „depusă” cere numărul și fișierul exact al recipisei; ambele se sigilează în aceeași operațiune.', { title: 'Confirmi declarația depusă', label: 'Recipisă / index', required: true, minLength: 2, confirmLabel: 'Alege fișierul recipisei' });
      if (v == null) { loadDeclRegister(sel.dataset.period); return; }
      const file = await chooseFilingProof();
      if (!file) { loadDeclRegister(sel.dataset.period); return; }
      const form = new FormData(); form.append('tip', sel.dataset.tip); form.append('period', sel.dataset.period);
      form.append('dossierId', sel.dataset.dossierId); form.append('recipisa', v); form.append('file', file, file.name);
      await api('/api/declarations/confirm-filed', { method: 'POST', body: form });
      toast('Depunerea și recipisa exactă au fost sigilate în dosar');
      loadDeclRegister(sel.dataset.period); refreshNotifBadge(); return;
    }
    if (sel.value === 'eroare' || sel.value === 'scutita') {
      const v = await promptAction('Explicația păstrează motivul verificabil al acestei stări.', { title: sel.value === 'eroare' ? 'Declarație cu eroare' : 'Declarație scutită', label: 'Explicație', required: true, minLength: 3, multiline: true, confirmLabel: 'Salvează starea' });
      if (v == null) { loadDeclRegister(sel.dataset.period); return; }
      body.note = v;
    }
    await api('/api/declarations/set', { method: 'POST', body: JSON.stringify(body) });
    toast('Stare salvată: ' + DECL_ST[sel.value].t);
    loadDeclRegister(sel.dataset.period);
    refreshNotifBadge();
  }));
  box.querySelectorAll('.decl-approve').forEach((button) => button.addEventListener('click', async () => {
    const hash = button.dataset.artifactHash;
    if (!await confirmAction('Ai verificat documentul cu SHA-256 complet:\n\n' + hash
      + '\n\nAprobarea va rămâne legată definitiv de acești octeți; orice regenerare cere o aprobare nouă.', {
      title: 'Aprobi documentul exact?', confirmLabel: 'Aprobă acest SHA-256',
    })) return;
    await api('/api/declarations/approve', { method: 'POST', body: JSON.stringify({
      tip: button.dataset.tip, period: button.dataset.period, dossierId: button.dataset.dossierId,
      artifactHash: hash,
    }) });
    toast('Document aprobat pe SHA-256 exact'); loadDeclRegister(button.dataset.period); refreshNotifBadge();
  }));
  box.querySelectorAll('.decl-receipt').forEach((input) => input.addEventListener('change', async () => {
    const file = input.files && input.files[0]; if (!file) return;
    const form = new FormData(); form.append('tip', input.dataset.tip); form.append('period', input.dataset.period);
    form.append('dossierId', input.dataset.dossierId);
    form.append('ordinal', input.dataset.ordinal); form.append('file', file, file.name);
    try {
      await api('/api/declarations/recipisa-file', { method: 'POST', body: form });
      toast('Fișierul exact al recipisei a fost păstrat cu SHA-256'); loadDeclRegister(input.dataset.period);
    } catch (e) { toast(e.message, true); input.value = ''; }
  }));
  box.querySelectorAll('.decl-artifact').forEach((input) => input.addEventListener('change', async () => {
    const file = input.files && input.files[0]; if (!file) return;
    let reason = '';
    const send = () => {
      const form = new FormData(); form.append('tip', input.dataset.tip); form.append('period', input.dataset.period);
      form.append('dossierId', input.dataset.dossierId);
      form.append('ordinal', input.dataset.ordinal); form.append('file', file, file.name);
      if (reason) form.append('reason', reason);
      return api('/api/declarations/artifact-file', { method: 'POST', body: form });
    };
    try {
      await send();
      toast('Fișierul efectiv depus a fost păstrat cu SHA-256'); loadDeclRegister(input.dataset.period);
    } catch (e) {
      let finalError = e;
      if (e.data && e.data.reasonRequired && !reason) {
        reason = await promptAction('Fișierul diferă de amprenta istorică. Binarul vechi rămâne păstrat; explică de ce fișierul selectat este cel efectiv transmis.', { title: 'Confirmi alt binar depus', label: 'Motiv / validator extern', required: true, minLength: 10, multiline: true, confirmLabel: 'Păstrează ambele versiuni' });
        if (reason != null) try { await send(); toast('Fișierul efectiv depus a fost păstrat separat'); loadDeclRegister(input.dataset.period); return; } catch (retryError) { finalError = retryError; }
      }
      toast(finalError.message, true); input.value = '';
    }
  }));
}

// ───────────────────────── FISA ROL / DOCUMENTE SPV ─────────────────────────
$('#fisaRolBtn') && $('#fisaRolBtn').addEventListener('click', async () => {
  $('#fisaRolStatus').textContent = 'se trimite cererea…';
  try {
    const r = await api('/api/anaf/fisa-rol', { method: 'POST' });
    $('#fisaRolStatus').textContent = r.mesaj || 'Solicitare depusă.';
    toast('Cerere Fișa Rol depusă în SPV');
  } catch (e) { $('#fisaRolStatus').textContent = ''; toast(e.message, true); }
});
$('#spvMesajeBtn') && $('#spvMesajeBtn').addEventListener('click', loadSpvMesaje);
async function loadSpvMesaje() {
  const box = $('#spvMesajeList');
  box.innerHTML = '<p class="muted">se încarcă…</p>';
  let msgs;
  try { msgs = await api('/api/anaf/spv-mesaje?zile=30'); }
  catch (e) { box.innerHTML = ''; toast(e.message, true); return; }
  box.innerHTML = msgs.length
    ? `<table><thead><tr><th>Data</th><th>Tip</th><th>Detalii</th><th></th></tr></thead><tbody>${
      msgs.map((m) => `<tr><td class="muted">${(m.data || '').slice(0, 16)}</td><td>${H(m.tip || '')}</td><td>${H(m.detalii || '')}</td>
        <td><button class="linkbtn spv-dl" data-id="${m.id}" data-detalii="${H(m.detalii || m.tip || 'Document SPV')}">descarcă</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Niciun mesaj în SPV pe ultimele 30 de zile.</p>';
  box.querySelectorAll('.spv-dl').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api('/api/anaf/spv-descarca/' + b.dataset.id, { method: 'POST', body: JSON.stringify({ detalii: b.dataset.detalii }) });
      toast('Document atașat firmei');
      window.open('/api/document/' + r.documentId + '/file', '_blank');
    } catch (e) { toast(e.message, true); }
  }));
}

// ───────────────────────── PORTOFOLIU (multi-firma) ─────────────────────────
onPeriodChange('portofoliu', loadPortfolio);
async function loadPortfolio() {
  const p = pget('portofoliu') || new Date().toISOString().slice(0, 7);
  const d = await api('/api/portfolio?period=' + p);
  const t = d.tot;
  const pinfo = (info) => `<span class="cinfo" tabindex="0" role="note" aria-label="${info}">i<span class="cpop">${info}</span></span>`;
  const kpi = (ic, lbl, val, sub, cls, info) => `<div class="kpi ${cls || ''}">
    <div class="kpi-top"><span class="kpi-ic">${ic}</span></div>
    <div class="lbl">${lbl}${info ? pinfo(info) : ''}</div><div class="val">${val}</div><div class="sub">${sub || ''}</div></div>`;
  $('#portoKpis').innerHTML =
    kpi('🏢', 'Firme în portofoliu', d.firms.length, 'cu acces', 'blue',
      'Firmele la care ai acces și care intră în agregarea de mai jos.') +
    kpi('📄', 'Declarații așteptate', t.asteptate, 'luna ' + p, 'blue',
      'Câte declarații au de depus firmele tale pe luna selectată, după profilul fiecăreia (TVA, angajați, trimestru).') +
    kpi('✅', 'Depuse', t.depuse, t.transmise + ' transmise · ' + (t.aprobate || 0) + ' aprobate · ' + t.generate + ' generate · ' + t.nedepuse + ' nedepuse', 'green',
      '„Transmise” au fost trimise către ANAF, dar nu sunt încă depuse fără recipisa de acceptare.') +
    kpi('🛡️', 'Conformitate', d.conformitate + '%', t.restante + ' restanțe · ' + t.erori + ' erori', t.restante || t.erori ? 'red' : 'green',
      'Depuse împărțit la datorate (fără scutite). Restanțele = termen depășit fără depunere.');
  // bara de status (stacked) + legenda cu numarul pe fiecare stare
  const segs = [['depuse', '#0a7d33'], ['transmise', '#6b46c1'], ['aprobate', '#4f6f12'], ['generate', '#1652d6'], ['nedepuse', '#b26a00'], ['erori', '#b00020'], ['scutite', '#8a93a3']];
  const total = Math.max(1, t.asteptate);
  $('#portoStatus').innerHTML =
    `<div data-u="u150">${
      segs.map(([k, c]) => t[k] ? `<div data-style="flex:${t[k]};background:${c}" title="${k}: ${t[k]}"></div>` : '').join('')}</div>
     <table data-u="u8">${segs.map(([k, c]) => `<tr><td><b data-style="color:${c}">●</b> ${k[0].toUpperCase() + k.slice(1)}</td><td class="num">${t[k]}</td><td class="num muted">${Math.round((t[k] / total) * 100)}%</td></tr>`).join('')}</table>`;
  const warn = d.firms.filter((f) => f.natentionari > 0).slice(0, 5);
  $('#portoTop').innerHTML = warn.length
    ? `<table>${warn.map((f) => `<tr><td>${H(f.nume)}<br><span class="muted" data-u="u148">${H(f.atentionari.slice(0, 3).join(' · '))}</span></td>
        <td class="num"><span data-u="u151">${f.natentionari}</span></td></tr>`).join('')}</table>`
    : '<p class="muted">✓ Nicio firmă cu atenționări pe luna selectată.</p>';
  // forma juridica (SRL/PFA + TVA) si starea abonamentului (billing per-firma)
  const formaBadge = (f) => {
    const t = f.tipEntitate === 'pfa'
      ? '<span class="pill" data-u="u152" title="Persoană fizică autorizată / întreprindere individuală">PFA</span>'
      : '<span class="pill" data-u="u153" title="Societate cu răspundere limitată">SRL</span>';
    return t + (f.tvaPlatitor ? ' <span class="pill" data-u="u154" title="Plătitoare de TVA">TVA</span>' : '');
  };
  const abonBadge = (s) => {
    s = s || {};
    if (s.status === 'trial') return `<span class="pill" data-u="u11" title="În probă (testare)">🎁 testare · ${s.zileRamase}z</span>`;
    if (s.status === 'active') { const pl = s.plan === 'pro' ? 'ab.Pro' : s.plan === 'start' ? 'ab.Start' : 'activ'; return `<span class="pill" data-u="u155">✓ ${pl}</span>`; }
    if (s.status === 'expired') return '<span class="pill warn">probă expirată</span>' + (s.pending ? ' <span class="pill" data-u="u11">⏳ plată</span>' : '');
    return '<span class="pill warn">fără abonament</span>' + (s.pending ? ' <span class="pill" data-u="u11">⏳ plată</span>' : '');
  };
  $('#portoFirms').innerHTML = `<table><thead><tr><th>Firma</th><th>CUI</th><th>Formă</th><th>Abonament</th><th class="num">Așteptate</th><th class="num">Depuse</th><th class="num">Transmise</th><th class="num">Aprobate</th><th class="num">Generate</th><th class="num">Nedepuse</th><th class="num">Erori</th><th class="num">Atenționări</th></tr></thead><tbody>${
    d.firms.map((f) => `<tr><td>${H(f.nume)}</td><td class="muted">${H(f.cui)}</td><td>${formaBadge(f)}</td><td>${abonBadge(f.sub)}</td><td class="num">${f.counts.asteptate}</td><td class="num" data-u="u156">${f.counts.depuse}</td><td class="num">${f.counts.transmise}</td><td class="num">${f.counts.aprobate || 0}</td><td class="num">${f.counts.generate}</td><td class="num" ${f.counts.nedepuse ? 'data-u="u157"' : ''}>${f.counts.nedepuse}</td><td class="num" ${f.counts.erori ? 'data-u="u33"' : ''}>${f.counts.erori}</td><td class="num">${f.natentionari || ''}</td></tr>`).join('')}</tbody></table>`;
  $('#portoRecent').innerHTML = (d.recent || []).length
    ? `<table><thead><tr><th>Când</th><th>Firma</th><th>Cine</th><th>Acțiune</th></tr></thead><tbody>${
      d.recent.map((a) => `<tr><td class="muted">${(a.ts || '').replace('T', ' ').slice(0, 16)}</td><td>${H(a.firma)}</td><td>${H(a.username)}</td><td>${H(a.action)}${a.detail ? ' — <span class="muted">' + H(a.detail) + '</span>' : ''}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio activitate recentă.</p>';
}

// ───────────────────────── SARCINI PERSONALE + NOTIFICARI FISCALE ─────────────────────────
async function refreshNotifBadge() {
  try {
    const [n, tasks] = await Promise.all([api('/api/notifications'), api('/api/tasks/mine')]);
    const b = $('#notifBadge'); if (!b) return;
    const total = (n.count || 0) + (tasks.unread || 0);
    b.textContent = total;
    b.classList.toggle('hidden', !total);
  } catch (e) { /* ignora */ }
}
// Ecranul de notificari era o FUNDATURA: 13 randuri rosii „RESTANȚĂ", niciun link, niciun buton,
// niciun handler. Utilizatorul afla ca are 13 probleme si nu putea face nimic de acolo — trebuia
// sa retina firma, luna si declaratia, apoi sa le regaseasca singur prin meniu.
// Acum fiecare rand duce exact la ecranul care il rezolva, pe FIRMA si pe LUNA notificarii.
const NOTIF_ACT = { efactura: { tab: 'iesite', cta: 'Trimite în SPV' } };
export const notifAct = (it) => NOTIF_ACT[it.tip] || { tab: 'livrabile', cta: 'Deschide declarația' };
// Vechimea restantei = severitatea ei. O restanta de 66 de zile si una de 2 arata la fel altfel.
export function zileIntarziere(due, azi) {
  const z = Math.floor((Date.parse(azi || new Date().toISOString().slice(0, 10)) - Date.parse(due)) / 86400000);
  return z > 0 ? z : 0;
}
let NOTIF_ITEMS = [];
let MY_TASK_ITEMS = [];
const TASK_STATUS = { deschisa: 'deschisă', asteapta_patronul: 'așteaptă patronul',
  asteapta_contabilul: 'așteaptă contabilul', in_verificare: 'în verificare',
  deschis: 'de făcut', blocat: 'așteaptă' };
export function myTasksHtml(tasks) {
  if (!(tasks || []).length) return '<p class="muted">✓ Nu ai nicio sarcină deschisă alocată.</p>';
  return `<table><thead><tr><th></th><th>Firmă</th><th>Sarcină</th><th>Sursă</th><th>Termen</th><th>Stare</th><th></th></tr></thead><tbody>${
    tasks.map((t, idx) => `<tr${t.unread ? ' class="task-unread"' : ''}>
      <td>${t.unread ? '<span class="navbadge">nou</span>' : ''}</td><td>${H(t.firma)}</td>
      <td><b>${H(t.title)}</b>${t.description ? `<div class="muted">${H(t.description)}</div>` : ''}</td>
      <td>${t.source === 'monthly-close' ? `Închidere lunară · ${H(t.period)}` : 'Solicitare patron–contabil'}</td>
      <td>${t.due ? H(dataRo(t.due)) : '<span class="muted">—</span>'}</td>
      <td>${H(TASK_STATUS[t.status] || t.status || 'deschisă')}</td>
      <td><button class="btn small task-go" data-i="${idx}">Deschide →</button></td></tr>`).join('')}</tbody></table>`;
}
async function loadNotifications() {
  const [n, tasks] = await Promise.all([api('/api/notifications'), api('/api/tasks/mine')]);
  NOTIF_ITEMS = n.items;
  MY_TASK_ITEMS = tasks.items || [];
  const taskBox = $('#myTasksList'); if (taskBox) taskBox.innerHTML = myTasksHtml(MY_TASK_ITEMS);
  $('#notifList').innerHTML = n.items.length
    ? `<table><thead><tr><th></th><th>Firma</th><th>Declarația</th><th>Luna</th><th>Termen</th><th>Stare</th><th></th></tr></thead><tbody>${
      n.items.map((i, idx) => {
        const z = zileIntarziere(i.due);
        return `<tr>
        <td>${i.kind === 'restanta'
    ? `<span data-u="u158">⏰ RESTANȚĂ</span>${z ? ` <span class="muted">· ${z} ${z === 1 ? 'zi' : 'zile'}</span>` : ''}`
    : '<span data-u="u159">📅 termen apropiat</span>'}</td>
        <td>${H(i.firma)}</td><td>${H(i.nume)}</td><td>${H(i.period)}</td>
        <td ${i.kind === 'restanta' ? 'data-u="u33"' : ''}>${i.due}</td>
        <td>${declBadge(i.status, i.kind === 'restanta' ? 'restanta' : 'termen')}</td>
        <td><button class="btn small notif-go" data-i="${idx}">${H(notifAct(i).cta)} →</button></td></tr>`;
      }).join('')}</tbody></table>`
    : '<p class="muted">✓ Nicio restanță și niciun termen în următoarele 7 zile. Totul e la zi.</p>';
  $$('#notifList .notif-go').forEach((b) => b.addEventListener('click', () => rezolvaNotificare(NOTIF_ITEMS[Number(b.dataset.i)])));
  $$('#myTasksList .task-go').forEach((b) => b.addEventListener('click', () => rezolvaSarcina(MY_TASK_ITEMS[Number(b.dataset.i)])));
  if (tasks.unread) {
    try { await api('/api/tasks/mine/read', { method: 'POST' }); } catch (_) { /* ramane necitita */ }
  }
  refreshNotifBadge();
}

export async function rezolvaSarcina(task) {
  if (!task) return;
  try {
    if (task.firmaId && D.activateFirma) await D.activateFirma(task.firmaId);
    if (task.source === 'monthly-close') {
      if (task.period && D.setWorkMonth) { D.setWorkMonth(task.period); if (D.applyWorkMonth) D.applyWorkMonth(); }
      if (D.goTab) D.goTab('inchideri');
      return;
    }
    try { sessionStorage.setItem('contab_open_task', String(task.id)); } catch (_) { /* indisponibil */ }
    if (D.goTab) D.goTab('colaborare');
  } catch (e) { toast(e.message, true); }
}
// Firma, apoi luna, apoi ecranul — in ordinea asta: schimbarea firmei reincarca META si retrimite
// tab-ul activ, deci o luna pusa inainte s-ar pierde.
// Exportata fiindca acelasi rand apare acum si pe Acasa („De facut acum"): daca fiecare ecran si-ar
// scrie propria navigare, ordinea firma → luna → tab ar drifta intr-unul din ele, tacut.
export async function rezolvaNotificare(it) {
  if (!it) return;
  const a = notifAct(it);
  try {
    if (it.firmaId && D.activateFirma) {
      const schimbat = await D.activateFirma(it.firmaId);
      if (schimbat) toast('Firmă activă: ' + it.firma);
    }
    if (it.period && D.setWorkMonth) { D.setWorkMonth(it.period); if (D.applyWorkMonth) D.applyWorkMonth(); }
    if (D.goTab) D.goTab(a.tab);
  } catch (e) { toast(e.message, true); }
}

// ───────────────────────── RECONCILIERE ─────────────────────────
$('#reconRefresh').addEventListener('click', loadReconcile);
// Datele de punctaj per partener (indexate pe pozitia din lista), pentru randarea bifelor la schimbarea platii.
let RECON_PM = [];
async function loadReconcile() {
  const r = await api('/api/reconcile');
  $('#reconSummary').innerHTML =
    // Fără coduri de cont în titlu: cardurile acoperă acum tot perimetrul de terți, nu doar
    // 4111/401. Nici „(net)" nu mai e exact — totalul nu compensează între parteneri.
    `<div class="card"><h3>De încasat de la clienți</h3><p data-u="u160">${fmt(r.totalClienti)} lei</p><p class="muted">creanțe deschise, pe toți partenerii</p></div>
     <div class="card"><h3>De plătit către furnizori</h3><p data-u="u161">${fmt(r.totalFurnizori)} lei</p><p class="muted">datorii deschise, pe toți partenerii</p></div>`;
  renderCompensations();
  RECON_PM = [];
  if (!r.partners.length) { $('#reconList').innerHTML = '<div class="card"><p class="muted">Nicio mișcare pe parteneri.</p></div>'; return; }
  $('#reconList').innerHTML = r.partners.map((p, pi) => {
    // Preluarea n-are data reala: `1900-01-01` e doar santinela care o tine prima la stingerea
    // FIFO. Afisata ca atare arata a eroare de date, deci in fisa apare eticheta, nu santinela.
    const rows = p.items.map((it) => `<tr class="${it.matched ? '' : ''}"><td>${it.soldInitial ? '<span class="muted">preluare</span>' : it.data}</td><td>${it.doc}</td><td>${it.tipNume}</td>
      <td class="num">${it.debit ? fmt(it.debit) : ''}</td><td class="num">${it.credit ? fmt(it.credit) : ''}</td>
      <td>${it.matched ? '<span class="pill">✓ potrivit</span>' : '<span class="pill warn">deschis</span>'}</td></tr>`).join('');
    // Sensul vine de la server (`sens`), nu se mai deduce aici din codul de cont: fisele acoperă
    // acum tot perimetrul de terți (418/461 la creanțe, 404/408/419/462 la datorii), iar regula
    // scrisă ca „4111 sau altfel furnizor” ar fi citit invers orice cont de creanță în plus.
    const creanta = p.sens === 'creanta';
    const lbl = creanta ? 'de încasat' : 'de plătit';
    // punctaj manual: la creanță plata = credit, factura = debit; la datorie invers
    const payAmt = (it) => (creanta ? it.credit : it.debit);
    const invAmt = (it) => (creanta ? it.debit : it.credit);
    // Soldul initial preluat apare in fisa (e o datorie/creanta reala), dar NU in punctajul manual:
    // n-are articol contabil in spate, deci n-are ce lega — ruta l-ar respinge cu 404.
    const legabil = (it) => !it.soldInitial;
    const plati = p.items.filter((it) => legabil(it) && payAmt(it) > 0).map((it) => ({ id: it.entryId, doc: it.doc, data: it.data, suma: payAmt(it), stinge: Array.isArray(it.stinge) ? it.stinge : [] }));
    const facturi = p.items.filter((it) => legabil(it) && invAmt(it) > 0).map((it) => ({ id: it.entryId, doc: it.doc, data: it.data, suma: invAmt(it) }));
    RECON_PM[pi] = { plati, facturi };
    const punctaj = (plati.length && facturi.length) ? `
      <details class="pm-box">
        <summary>🔗 Punctaj manual — leagă o plată de facturile pe care le stinge</summary>
        <label class="pm-pay-row">Plata: <select class="pm-pay" data-pi="${pi}">${plati.map((pl) => `<option value="${H(pl.id)}">${pl.data} · ${H(pl.doc || 'fără doc')} · ${fmt(pl.suma)} lei${pl.stinge.length ? ' · ' + pl.stinge.length + ' legate' : ''}</option>`).join('')}</select></label>
        <div class="pm-inv" data-pi="${pi}"></div>
        <button class="btn small pm-save" data-pi="${pi}">Salvează punctajul</button>
        <span class="muted"> Bifează facturile stinse de plata aleasă; debifează pentru a dezlega.</span>
      </details>` : '';
    return `<div class="ledger-acc">
      <h4><span class="acc adv">${p.cont}</span> ${H(p.den)} ${p.cui ? '<span class="muted">(' + H(p.cui) + ')</span>' : ''} <span class="pill">${lbl}</span></h4>
      <p class="muted">Facturat: ${fmt(p.facturat)} · Decontat: ${fmt(p.decontat)} · <b>Sold: ${fmt(p.sold)}</b> · Potriviri: ${p.potriviri} · Deschise: ${p.nepotrivite}</p>
      <div class="tablewrap"><table><thead><tr><th>Data</th><th>Document</th><th>Tip</th><th class="num">Debit</th><th class="num">Credit</th><th>Stare</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${punctaj}
    </div>`;
  }).join('');
  wireReconPunctaj();
}

// Randeaza bifele de facturi pentru plata selectata (pre-bifate = deja legate prin `stinge`).
function renderPmInv(pi) {
  const sel = $(`.pm-pay[data-pi="${pi}"]`); const box = $(`.pm-inv[data-pi="${pi}"]`);
  const pm = RECON_PM[pi]; if (!sel || !box || !pm) return;
  const pay = pm.plati.find((pl) => String(pl.id) === sel.value) || pm.plati[0];
  const linked = new Set(pay ? pay.stinge.map(String) : []);
  box.innerHTML = pm.facturi.map((f) => `<label class="pm-inv-item"><input type="checkbox" class="pm-cb" value="${H(f.id)}" ${linked.has(String(f.id)) ? 'checked' : ''}> ${f.data} · ${H(f.doc || 'fără doc')} · ${fmt(f.suma)} lei</label>`).join('') || '<span class="muted">Nicio factură.</span>';
}

function wireReconPunctaj() {
  $$('.pm-pay').forEach((sel) => { renderPmInv(sel.dataset.pi); sel.addEventListener('change', () => renderPmInv(sel.dataset.pi)); });
  $$('.pm-save').forEach((btn) => btn.addEventListener('click', async () => {
    const pi = btn.dataset.pi; const sel = $(`.pm-pay[data-pi="${pi}"]`);
    const paymentId = sel && sel.value; if (!paymentId) return;
    const invoiceIds = $$(`.pm-inv[data-pi="${pi}"] .pm-cb`).filter((c) => c.checked).map((c) => c.value);
    try { await api('/api/reconcile/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentId, invoiceIds }) }); toast('Punctaj salvat'); loadReconcile(); }
    catch (e) { toast(e.message, true); }
  }));
}

async function renderCompensations() {
  const card = $('#compensCard'); if (!card) return;
  let list; try { list = await api('/api/compensations'); } catch (e) { card.classList.add('hidden'); return; }
  if (!list.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('#compensView').innerHTML = `<table><thead><tr><th>Partener</th><th class="num">Creanță${ac('4111')}</th><th class="num">Datorie${ac('401')}</th><th class="num">Compensabil</th><th></th></tr></thead>
    <tbody>${list.map((c) => `<tr data-cui="${H(c.cui)}"><td>${H(c.den)}${c.cui ? ' <span class="muted">(' + H(c.cui) + ')</span>' : ''}</td>
      <td class="num">${fmt(c.creanta)}</td><td class="num">${fmt(c.datorie)}</td><td class="num"><b>${fmt(c.compensabil)}</b></td>
      <td><button class="btn small primary compBtn" data-cui="${H(c.cui)}" data-max="${c.compensabil}">Compensează</button></td></tr>`).join('')}</tbody></table>`;
  $$('#compensView .compBtn').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmAction('Suma maximă compensabilă este ' + fmt(Number(b.dataset.max)) + ' lei pentru acest partener.', { title: 'Înregistrezi compensarea?', detail: 'Operațiunea contabilă este 401 = 4111.', confirmLabel: 'Compensează', danger: true })) return;
    b.disabled = true;
    try {
      const r = await api('/api/compensations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cui: b.dataset.cui }) });
      toast('Compensat ' + fmt(r.compensat) + ' lei (401 = 4111)');
      loadReconcile(); loadEntries();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }));
}
// ───────────────────────── ANALITIC ─────────────────────────
const ANALYTIC_ACCOUNTS = ['401', '404', '408', '409', '419', '4111', '418', '461', '462', '5121', '5124', '5311', '5314', '542', '421', '425'];
async function renderAging() {
  let a; try { a = await api('/api/aging'); } catch (e) { return; }
  const tbl = (titlu, list, t, lbl, wo) => `<div class="card"><h4>${titlu} <span class="muted" data-u="u70">la ${a.asOf}</span></h4>${
    list.length ? `<table><thead><tr><th>Partener</th><th class="num">Total</th><th class="num">Nescadent</th><th class="num">0-30</th><th class="num">31-60</th><th class="num">61-90</th><th class="num">&gt;90</th>${wo ? '<th></th>' : ''}</tr></thead><tbody>${
      list.map((x) => `<tr><td>${H(x.partener)}${x.cui ? ' <span class="muted">(' + H(x.cui) + ')</span>' : ''}${x.dueDateMissing ? '<br><span class="pill warn">scadențe lipsă: ' + fmt(x.dueDateMissing) + '</span>' : ''}</td><td class="num">${fmt(x.total)}</td><td class="num">${x.nescadent ? fmt(x.nescadent) : ''}</td><td class="num">${x.b0_30 ? fmt(x.b0_30) : ''}</td><td class="num">${x.b31_60 ? fmt(x.b31_60) : ''}</td><td class="num">${x.b61_90 ? fmt(x.b61_90) : ''}</td><td class="num">${x.b90plus ? fmt(x.b90plus) : ''}</td>${wo ? `<td><button class="linkbtn woff" data-p="${encodeURIComponent(x.partener)}" data-c="${H(x.cui)}" data-s="${x.total}">scoate</button></td>` : ''}</tr>`).join('')}
      <tr class="bold"><td>TOTAL ${lbl}</td><td class="num">${fmt(t.total)}</td><td class="num">${fmt(t.nescadent || 0)}</td><td class="num">${fmt(t.b0_30)}</td><td class="num">${fmt(t.b31_60)}</td><td class="num">${fmt(t.b61_90)}</td><td class="num">${fmt(t.b90plus)}</td>${wo ? '<td></td>' : ''}</tr></tbody></table>`
      : '<p class="muted">Niciun sold restant.</p>'}</div>`;
  $('#agingView').innerHTML = tbl('De încasat (clienți)', a.clienti, a.totalClienti, 'creanțe', true) + tbl('De plătit (furnizori)', a.furnizori, a.totalFurnizori, 'datorii', false);
  $$('#agingView .woff').forEach((b) => b.addEventListener('click', async () => {
    const partener = decodeURIComponent(b.dataset.p);
    const suma = await promptAction('Creanța partenerului ' + partener + ' va fi scoasă din evidență prin operațiunea 654 = 4111.', {
      title: 'Scoți creanța din evidență?', label: 'Sumă neîncasabilă', inputType: 'number', value: b.dataset.s,
      required: true, pattern: /^\d+(?:[.,]\d{1,2})?$/, patternMessage: 'Introdu o sumă pozitivă, cu cel mult două zecimale.', confirmLabel: 'Înregistrează scoaterea', danger: true,
    });
    if (!suma) return;
    try { const r = await api('/api/writeoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partener, cui: b.dataset.c, suma }) }); toast('Creanță scoasă: ' + fmt(r.suma) + (r.reversProvizion ? ' (+ reluare provizion ' + fmt(r.reversProvizion) + ')' : '')); loadAnalytic(); }
    catch (e) { toast(e.message, true); }
  }));
  renderProvizion();
  renderOpenItems();
}

async function renderOpenItems() {
  const box = $('#openItemsView'); if (!box) return;
  let r; let ctl;
  try { [r, ctl] = await Promise.all([api('/api/open-items'), api('/api/open-items/reconciliation')]); } catch (e) { box.innerHTML = '<p class="muted">' + H(e.message) + '</p>'; return; }
  const control = $('#openItemsControl');
  if (control) control.innerHTML = `<p class="${ctl.ok ? 'muted' : 'error'}">${ctl.ok ? '✓' : '⚠'} Control la ${H(ctl.asOf)}: registrul ${ctl.ok ? 'reconciliază' : 'NU reconciliază'} cu soldurile 401/404/408/4111/418/419/461/462${ctl.difference ? ' · diferență ' + fmt(ctl.difference) : ''}.</p>`;
  if (!r.documents.length) { box.innerHTML = '<p class="muted">Niciun document deschis.</p>'; return; }
  const tri = (v) => `<option value="" ${v == null ? 'selected' : ''}>neconfirmat</option><option value="false" ${v === false ? 'selected' : ''}>nu</option><option value="true" ${v === true ? 'selected' : ''}>da</option>`;
  box.innerHTML = `<table><thead><tr><th>Document / partener</th><th>Cont</th><th>Scadență</th><th class="num">Sold rezidual</th><th>Prob. încasare</th><th>Întârziere</th><th>Litigiu</th><th>Afiliat</th><th>Garantat</th><th></th></tr></thead><tbody>${r.documents.map((d) => `<tr data-oi="${H(d.id)}">
    <td><b>${H(d.document || d.id)}</b><br>${H(d.partener)}${d.allocations.length ? '<br><span class="muted">' + d.allocations.length + ' stingeri</span>' : ''}${d.metadataHistoryCount ? '<br><span class="muted">' + d.metadataHistoryCount + ' modificări auditate</span>' : ''}</td><td class="acc">${H(d.account)}</td>
    <td><input class="oi-due" type="date" value="${d.dueKnown ? H(d.dueDate) : ''}">${!d.dueKnown ? '<br><span class="pill warn">lipsește</span>' : (d.status === 'restant' ? '<br><span class="pill warn">' + d.overdueDays + ' zile</span>' : '')}</td>
    <td class="num"><b>${fmt(d.residual)}</b></td><td>${d.sens === 'creanta' ? `<input class="oi-prob" type="number" min="0" max="100" step="1" value="${d.collectionProbability == null ? '' : H(d.collectionProbability)}" placeholder="100" aria-label="Probabilitate de încasare procent">%` : '<span class="muted">100%</span>'}</td><td><input class="oi-delay" type="number" min="0" max="365" step="1" value="${H(d.forecastDelayDays || 0)}" aria-label="Întârziere estimată în zile"> zile</td><td><select class="oi-dispute">${tri(d.dispute)}</select></td><td><select class="oi-aff">${tri(d.affiliated)}</select></td><td><select class="oi-guar">${tri(d.guaranteed)}</select></td>
    <td><button class="btn small oi-save">Salvează</button></td></tr>`).join('')}</tbody></table>`;
  const val = (sel) => sel.value === 'true' ? true : sel.value === 'false' ? false : null;
  $$('#openItemsView .oi-save').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    const reason = await promptAction('Schimbarea nu modifică nota contabilă, dar afectează aging-ul, Nota 5 și analiza fiscală. Va rămâne în istoricul documentului.', {
      title: 'Actualizezi documentul deschis?', label: 'Motiv / document suport', required: true,
      pattern: /^.{5,300}$/, patternMessage: 'Scrie un motiv de cel puțin 5 caractere.', confirmLabel: 'Salvează',
    });
    if (!reason) return;
    try {
      await api('/api/open-items/' + encodeURIComponent(tr.dataset.oi), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        dueDate: tr.querySelector('.oi-due').value, dispute: val(tr.querySelector('.oi-dispute')),
        affiliated: val(tr.querySelector('.oi-aff')), guaranteed: val(tr.querySelector('.oi-guar')),
        collectionProbability: tr.querySelector('.oi-prob') ? tr.querySelector('.oi-prob').value : null,
        forecastDelayDays: tr.querySelector('.oi-delay').value, reason,
      }) });
      toast('Document deschis actualizat'); renderAging();
    } catch (e) { toast(e.message, true); }
  }));
}
async function renderProvizion() {
  const pct = $('#provPct').value || 100;
  let p; try { p = await api('/api/provizion?pct=' + pct); } catch (e) { return; }
  // Coloana „eligibil art. 26" arata DE CE o creanta veche nu aduce deducere: sub 270 de zile,
  // garantata sau debitor afiliat. Fara ea, contabilul nu poate distinge o baza fiscala mica de
  // un defect de calcul.
  const a26 = p.art26 || {};
  const det = p.detalii.length
    ? `<table><thead><tr><th>Document / partener</th><th>Scadență</th><th class="num">Creanțe &gt;90 zile</th><th class="num">Provizion ${p.pct}%</th><th class="num">Eligibil art. 26</th></tr></thead><tbody>${
      p.detalii.map((c) => `<tr><td>${H(c.document || c.documentId || 'fără document')}<br><span class="muted">${H(c.partener)}${c.cui ? ' (' + H(c.cui) + ')' : ''}</span></td><td>${c.scadenta ? H(c.scadenta) + '<br><span class="muted">' + H(c.zileRestanta) + ' zile</span>' : '<span class="pill warn">neconfirmată</span>'}</td><td class="num">${fmt(c.vechi)}</td><td class="num">${fmt(c.provizion)}</td><td class="num">${
  c.excluderi && c.excluderi.length ? `<span class="muted">— ${H(c.excluderi.join(', '))}</span>` : fmt(c.eligibilArt26)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio creanță mai veche de 90 de zile.</p>';
  $('#provView').innerHTML = det + `<table data-u="u23"><tbody>
    <tr><td>Provizion necesar (${p.pct}%)</td><td class="num">${fmt(p.necesar)}</td></tr>
    <tr><td>Ajustare existentă${ac('491')}</td><td class="num">${fmt(p.existent)}</td></tr>
    <tr class="bold"><td>De înregistrat<span class="adv"> (${provizionDirectie(p.deAjustat)})</span></td><td class="num">${fmt(Math.abs(p.deAjustat))}</td></tr>
    <tr><td>Deducere fiscală maximă<span class="adv"> (${a26.pctDeductibil || 30}% din ajustarea eligibilă)</span></td><td class="num">${fmt(a26.deducereMaxima || 0)}</td></tr></tbody></table>`
    + `<p class="muted">${H(a26.nota || '')}</p>`;
  // Confirmarea e OPRITA cand nu exista nimic eligibil: altfel ar sugera ca bifa poate produce o
  // deducere din nimic.
  const chk = $('#provArt26');
  if (chk) {
    chk.disabled = !(a26.ajustareEligibila > 0) || !(p.deAjustat > 0);
    if (chk.disabled) chk.checked = false;
  }
}
$('#provPct').addEventListener('input', renderProvizion);
$('#provPost').addEventListener('click', async () => {
  try {
    // Confirmarea art. 26 pleaca DOAR daca e bifata: fara ea baza fiscala ramane zero, iar
    // ajustarea e integral nedeductibila. E o declaratie a contabilului, nu o optiune de calcul.
    const confirmArt26 = !!($('#provArt26') && $('#provArt26').checked);
    const r = await api('/api/provizion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct: Number($('#provPct').value || 100), confirmArt26 }) });
    toast(r.message || ('Ajustare înregistrată: ' + fmt(Math.abs(r.result.deAjustat))));
    loadAnalytic();
  } catch (e) { toast(e.message, true); }
});
async function loadAnalytic() {
  const form = $('#oaForm');
  formFlowFlush(form);
  $('#oaCont').innerHTML = ANALYTIC_ACCOUNTS.map((c) => `<option value="${H(c)}">${H(c)} — ${H(accName(c))}</option>`).join('');
  formFlowLoaded(form, 'nou');
  await loadOpeningAnalytic();
  renderAging();
  const sections = await api('/api/analytic');
  if (!sections.length) { $('#analyticList').innerHTML = '<div class="card"><p class="muted">Niciun cont de terți cu solduri sau mișcări.</p></div>'; return; }
  $('#analyticList').innerHTML = sections.map((s) => {
    const rows = s.rows.map((r) => `<tr><td class="acc">${r.analitic}</td><td>${H(r.den)}${r.cui ? ' <span class="muted">(' + H(r.cui) + ')</span>' : ''}</td>
      <td class="num">${r.siD ? fmt(r.siD) : ''}</td><td class="num">${r.siC ? fmt(r.siC) : ''}</td>
      <td class="num">${fmt(r.rd)}</td><td class="num">${fmt(r.rc)}</td>
      <td class="num">${r.sfD ? fmt(r.sfD) : ''}</td><td class="num">${r.sfC ? fmt(r.sfC) : ''}</td></tr>`).join('');
    return `<div class="ledger-acc">
      <h4><span class="acc">${s.synth}</span> — ${H(s.nume)} ${s.concorda ? '' : '<span class="pill warn">SI ≠ sintetic</span>'}</h4>
      <div class="tablewrap"><table><thead><tr><th>Analitic</th><th>Partener</th><th class="num">SI D</th><th class="num">SI C</th><th class="num">Rulaj D</th><th class="num">Rulaj C</th><th class="num">SF D</th><th class="num">SF C</th></tr></thead>
      <tbody>${rows}<tr class="total"><td colspan="2">TOTAL ${s.synth}</td><td class="num">${fmt(s.totalSiD)}</td><td class="num">${fmt(s.totalSiC)}</td><td class="num">${fmt(s.totalRd)}</td><td class="num">${fmt(s.totalRc)}</td><td class="num">${fmt(s.totalSfD)}</td><td class="num">${fmt(s.totalSfC)}</td></tr></tbody></table></div>
    </div>`;
  }).join('');
}
async function loadOpeningAnalytic() {
  const arr = await api('/api/opening-analytic');
  $('#oaList').innerHTML = arr.length
    ? `<table><thead><tr><th>Cont</th><th>Partener</th><th>CUI</th><th class="num">Debit</th><th class="num">Credit</th><th></th></tr></thead><tbody>${
      arr.map((o, i) => `<tr><td class="acc">${H(o.cont)}</td><td>${H(o.partener)}</td><td>${H(o.cui)}</td>
        <td class="num">${fmt(o.d)}</td><td class="num">${fmt(o.c)}</td><td><button class="del oadel" data-i="${i}">✕</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Niciun sold inițial analitic.</p>';
  $$('#oaList .oadel').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/opening-analytic/' + b.dataset.i, { method: 'DELETE' }); loadAnalytic();
  }));
}
$('#oaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await api('/api/opening-analytic', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cont: f.cont.value, partener: f.partener.value, cui: f.cui.value, d: f.d.value, c: f.c.value }) });
  formFlowSaved(f); toast('Sold inițial analitic salvat'); f.partener.value = ''; f.cui.value = ''; f.d.value = '0'; f.c.value = '0';
  formFlowLoaded(f, 'nou', { restore: false });
  loadAnalytic();
});
function resetOpeningAnalytic(options = {}) {
  const form = $('#oaForm'); if (!form) return;
  formFlowFlush(form);
  form.reset(); form.d.value = '0'; form.c.value = '0';
  formFlowLoaded(form, 'nou', { restore: options.restoreDraft !== false });
}
window.addEventListener('contab:company-context', () => resetOpeningAnalytic());

registerFormFlow({
  form: '#oaForm',
  title: 'Soldul inițial pe partener',
  firstStepTitle: 'Cont și partener',
  entityKey: 'nou',
  progressFields: ['cont', 'partener', 'cui', 'd', 'c'],
  onDiscard: () => resetOpeningAnalytic({ restoreDraft: false }),
});


export { loadAnalytic, loadLivrabile, loadNotifications, loadPortfolio, loadReconcile, refreshNotifBadge };
// Exportate pentru testele unitare de frontend (insigna declaratiilor, sensul provizionului): test/frontend.mjs
export { declBadge, provizionDirectie };
