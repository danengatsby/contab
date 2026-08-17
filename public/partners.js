'use strict';
// Nomenclatorul de parteneri (clienti/furnizori): lista cu filtru pe tip, editare, adaugare si
// import in masa din CSV/XLSX. Extras din app.js (Etapa 7). Frunza — depinde doar de nucleu,
// nu apeleaza inapoi in app.js. loadPartners e apelat din onTab('parteneri').
import { $, $$, api, toast, H, fileToCsv, legaCompletareCui } from './core.js';
import { registerFormFlow, formFlowFlush, formFlowLoaded, formFlowSaved } from './formflow.js';

const TIP_PARTENER = { client: { t: 'Client', c: '#0b6e4f', bg: '#eaf4ef' }, furnizor: { t: 'Furnizor', c: '#b00020', bg: '#fdeef0' }, ambele: { t: 'Ambele', c: '#42506f', bg: '#eef1f7' } };
function tipBadge(tip) { const x = TIP_PARTENER[tip]; return x ? `<span data-style="background:${x.bg};color:${x.c};border-radius:6px;padding:1px 8px;font-size:11px;font-weight:700">${x.t}</span>` : '<span class="muted">—</span>'; }
/** Starea partenerului la ANAF, condensata intr-o insigna. Ordinea e cea a GRAVITATII fiscale:
 *  inactivul (art. 11) taie deductibilitatea, deci trece inaintea oricarei alte mentiuni. */
export function anafBadge(a) {
  if (!a || !a.verificatLa) return '<span class="muted" title="Neverificat în registrul ANAF — rulează verificarea">—</span>';
  if (a.gasit === false) return '<span data-style="color:#b00020;font-weight:700" title="CUI inexistent în registrul ANAF">✗ inexistent</span>';
  const zi = String(a.verificatLa).slice(0, 10);
  if (a.inactiv) {
    return `<span data-style="color:#b00020;font-weight:700" title="INACTIV${a.dataInactivare ? ' din ' + H(a.dataInactivare) : ''} — art. 11: cheltuiala și TVA-ul sunt nedeductibile (verificat ${H(zi)})">⛔ inactiv</span>`;
  }
  if (a.radiat) return `<span data-style="color:#b00020" title="${H(a.stareInregistrare || 'radiat')} (verificat ${H(zi)})">⚠ radiat</span>`;
  const note = [];
  if (!a.tvaPlatitor) note.push('<span data-style="color:#8a6d00" title="Neînregistrat în scopuri de TVA — facturile lui nu pot purta TVA deductibilă">fără TVA</span>');
  if (a.tvaLaIncasare) note.push('<span data-style="color:#8a6d00" title="Aplică TVA la încasare — deducerea ta se amână până la plata facturii (art. 297 alin. 2)">TVA la încasare</span>');
  if (a.splitTva) note.push('<span title="Plată defalcată a TVA">split</span>');
  if (a.eFactura) note.push('<span title="Înregistrat în registrul RO e-Factura">e-Factura</span>');
  const corp = note.length ? note.join(' · ') : '✓';
  return `<span class="muted" title="Verificat la ${H(zi)}">${corp}</span>`;
}

let PARTNERS_MAP = {};
export async function loadPartners() {
  PARTNERS_MAP = await api('/api/partners');
  renderPartners();
}
function renderPartners() {
  const map = PARTNERS_MAP;
  const ft = ($('#partnerTipFilter') && $('#partnerTipFilter').value) || '';
  let arr = Object.values(map);
  if (ft) arr = arr.filter((p) => p.tip === ft || (ft !== 'ambele' && p.tip === 'ambele'));
  $('#partnersList').innerHTML = arr.length
    ? `<table><thead><tr><th>CUI</th><th>Denumire</th><th>Tip</th><th>Oraș</th><th>Județ</th><th>ANAF</th><th></th></tr></thead><tbody>${
      arr.map((p) => `<tr><td class="acc">${H(p.cui)}</td><td>${H(p.den)}</td><td>${tipBadge(p.tip)}</td><td>${H(p.oras)}</td><td>${H(p.judet)}</td><td>${anafBadge(p.anaf)}</td>
        <td><button class="linkbtn pedit" data-cui="${H(p.cui)}">editează</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Niciun partener pentru filtrul ales. Partenerii se adaugă automat când introduci CUI pe o factură.</p>';
  $$('#partnersList .pedit').forEach((b) => b.addEventListener('click', () => {
    const p = map[b.dataset.cui]; const f = $('#partnerForm');
    formFlowFlush(f);
    ['cui', 'den', 'tip', 'adresa', 'oras', 'judet', 'tara'].forEach((k) => { if (f[k]) f[k].value = p[k] || ''; });
    $('#partnerFormMode').textContent = 'Editare';
    formFlowLoaded(f, 'partener:' + p.cui);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
}
$('#partnerTipFilter') && $('#partnerTipFilter').addEventListener('change', renderPartners);

// Completarea partenerului dupa CUI. Pe langa denumire si adresa, aici castigul mare e ALERTA:
// „Verifica la ANAF" exista deja, dar se ruleaza peste partenerii DEJA salvati — adica afli ca
// furnizorul e inactiv dupa ce i-ai inregistrat facturile. Acum semnalul vine cand tastezi CUI-ul,
// inainte de prima inregistrare: inactiv (art. 11) si TVA la incasare (art. 297 alin. (2)) schimba
// deductibilitatea, nu doar continutul unui camp.
legaCompletareCui($('#partnerForm'), {
  den: 'denumire', adresa: 'adresa', oras: 'localitate', judet: 'judet',
});
function golestePartener(options = {}) {
  const f = $('#partnerForm'); if (!f) return;
  formFlowFlush(f);
  f.reset();
  f.tara.value = 'RO';
  $('#partnerFormMode').textContent = 'Partener nou';
  formFlowLoaded(f, 'nou', { restore: options.restoreDraft !== false });
}
$('#partnerNou') && $('#partnerNou').addEventListener('click', () => golestePartener());
window.addEventListener('contab:company-context', () => golestePartener());
$('#partnerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { cui: f.cui.value, den: f.den.value, tip: f.tip.value, adresa: f.adresa.value, oras: f.oras.value, judet: f.judet.value, tara: f.tara.value };
  try {
    await api('/api/partners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    formFlowSaved(f);
    toast('Partener salvat'); golestePartener({ restoreDraft: false }); loadPartners();
  }
  catch (err) { toast(err.message, true); }
});
$('#partnersCsvFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) { try { $('#partnersCsvIn').value = await fileToCsv(f); } catch (err) { toast(err.message, true); } } });
$('#partnersImportBtn').addEventListener('click', async () => {
  const csv = $('#partnersCsvIn').value.trim();
  if (!csv) return toast('Lipiește sau încarcă un CSV', true);
  try {
    const r = await api('/api/partners/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
    toast(r.importati + ' parteneri importați' + (r.erori.length ? ' (' + r.erori.length + ' erori)' : ''));
    $('#partnersCsvIn').value = ''; loadPartners();
  } catch (err) { toast(err.message, true); }
});

// Verificarea in registrul public ANAF. Poate dura (loturi de 500, o cerere pe secunda), deci
// butonul se dezactiveaza si spune ce face — altfel pare ca n-a facut nimic.
$('#partnersAnafBtn') && $('#partnersAnafBtn').addEventListener('click', async () => {
  const b = $('#partnersAnafBtn');
  const textVechi = b.textContent;
  b.disabled = true; b.textContent = 'Se verifică la ANAF…';
  try {
    const r = await api('/api/partners/verifica-anaf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    $('#partnersAnafRez').innerHTML = sumarAnaf(r);
    toast(r.sumar.total + ' parteneri verificați');
    loadPartners();
  } catch (err) { toast(err.message, true); }
  finally { b.disabled = false; b.textContent = textVechi; }
});

/** Sumarul verificarii, cu constatarile care schimba un rezultat fiscal puse PRIMELE. */
export function sumarAnaf(r) {
  const s = (r && r.sumar) || {};
  const grave = [];
  if (s.inactivi) grave.push(`<b>${s.inactivi} inactiv(i)</b> — cheltuiala și TVA-ul de la ei sunt nedeductibile (art. 11)`);
  if (s.radiati) grave.push(`${s.radiati} radiat/radiați`);
  if (s.negasiti) grave.push(`${s.negasiti} cu CUI inexistent în registru`);
  const note = [];
  if (s.tvaLaIncasare) note.push(`${s.tvaLaIncasare} cu TVA la încasare (deducerea se amână până la plată)`);
  if (s.faraTva) note.push(`${s.faraTva} neînregistrați în scopuri de TVA`);
  if (s.cuDiferente) note.push(`${s.cuDiferente} cu date diferite de nomenclator`);
  const corp = [
    grave.length ? `<p data-style="color:#b00020">⚠ ${grave.join(' · ')}</p>` : '',
    note.length ? `<p class="muted">${note.join(' · ')}</p>` : '',
    (!grave.length && !note.length) ? '<p class="muted">✓ Niciun partener cu probleme.</p>' : '',
  ].join('');
  return `<div class="card"><h3>Verificare ANAF — ${H(String(s.total || 0))} parteneri, la ${H(String(r.data || ''))}</h3>${corp}</div>`;
}

// Exportat pentru testele unitare de frontend (insigne + sumar): test/frontend.mjs
export { tipBadge };

registerFormFlow({
  form: '#partnerForm',
  title: 'Datele partenerului',
  firstStepTitle: 'Identificare și rol',
  entityKey: 'nou',
  progressFields: ['cui', 'den', 'tip', 'adresa', 'oras', 'judet', 'tara'],
  onDiscard: () => golestePartener({ restoreDraft: false }),
});
