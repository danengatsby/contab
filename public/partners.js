'use strict';
// Nomenclatorul de parteneri (clienti/furnizori): lista cu filtru pe tip, editare, adaugare si
// import in masa din CSV/XLSX. Extras din app.js (Etapa 7). Frunza — depinde doar de nucleu,
// nu apeleaza inapoi in app.js. loadPartners e apelat din onTab('parteneri').
import { $, $$, api, toast, H, fileToCsv } from './core.js';

const TIP_PARTENER = { client: { t: 'Client', c: '#0b6e4f', bg: '#eaf4ef' }, furnizor: { t: 'Furnizor', c: '#b00020', bg: '#fdeef0' }, ambele: { t: 'Ambele', c: '#42506f', bg: '#eef1f7' } };
function tipBadge(tip) { const x = TIP_PARTENER[tip]; return x ? `<span style="background:${x.bg};color:${x.c};border-radius:6px;padding:1px 8px;font-size:11px;font-weight:700">${x.t}</span>` : '<span class="muted">—</span>'; }
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
    ? `<table><thead><tr><th>CUI</th><th>Denumire</th><th>Tip</th><th>Oraș</th><th>Județ</th><th></th></tr></thead><tbody>${
      arr.map((p) => `<tr><td class="acc">${H(p.cui)}</td><td>${H(p.den)}</td><td>${tipBadge(p.tip)}</td><td>${H(p.oras)}</td><td>${H(p.judet)}</td>
        <td><button class="linkbtn pedit" data-cui="${p.cui}">editează</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Niciun partener pentru filtrul ales. Partenerii se adaugă automat când introduci CUI pe o factură.</p>';
  $$('#partnersList .pedit').forEach((b) => b.addEventListener('click', () => {
    const p = map[b.dataset.cui]; const f = $('#partnerForm');
    ['cui', 'den', 'tip', 'adresa', 'oras', 'judet', 'tara'].forEach((k) => { if (f[k]) f[k].value = p[k] || ''; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
}
$('#partnerTipFilter') && $('#partnerTipFilter').addEventListener('change', renderPartners);
$('#partnerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { cui: f.cui.value, den: f.den.value, tip: f.tip.value, adresa: f.adresa.value, oras: f.oras.value, judet: f.judet.value, tara: f.tara.value };
  try { await api('/api/partners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast('Partener salvat'); f.reset(); f.tara.value = 'RO'; loadPartners(); }
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
