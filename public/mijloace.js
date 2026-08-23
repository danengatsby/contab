'use strict';

// Mijloace fixe: registru, fisa, amortizare lunara. Extras din app.js (Etapa: spargerea fisierului mare).
import { $$, $, H, fmt, toast, api, fileToCsv, confirmAction, applyFiscalDefaults } from './core.js';
import { pget, onPeriodChange } from './periods.js';
import { registerFormFlow, formFlowFlush, formFlowLoaded, formFlowSaved, formFlowDiscard } from './formflow.js';

// ───────────────────────── MIJLOACE FIXE ─────────────────────────
function mfAsOf() { return pget('mf') || new Date().toISOString().slice(0, 7); }
async function loadAssets() {
  const asOf = mfAsOf();
  $('#mfRegPdf').href = '/pdf/assets?asOf=' + asOf;
  const list = await api('/api/assets?asOf=' + asOf);
  $('#assetsList').innerHTML = list.length
    ? `<table><thead><tr><th>Denumire</th><th>Cont</th><th>Metodă</th><th>Data PIF</th><th class="num">Cost</th><th class="num">Amort./lună</th><th class="num">Cumulat</th><th class="num">Rămas</th><th></th></tr></thead><tbody>${
      list.map((a) => `<tr${a.status === 'casat' ? ' class="muted"' : ''}>
        <td>${H(a.denumire)}${a.status === 'casat' ? ' <span class="pill">casat</span>' : ''}${
  // Activele inregistrate INAINTE de gardele art. 28 raman pe disc si continua sa se amortizeze.
  // Nu se corecteaza singure (ar schimba retroactiv articole deja postate), deci se ARATA.
  (a.neconformitati && a.neconformitati.length)
    ? `<br><span class="status err">⚠ ${a.neconformitati.map((m) => H(m)).join('<br>⚠ ')}</span>` : ''}</td>
        <td class="acc">${a.cont}/${a.calc.contAmortizare}</td>
        <td>${({ liniara: 'liniară', degresiva: 'degresivă', accelerata: 'accelerată' })[a.metoda] || a.metoda}</td>
        <td>${a.dataPif}</td>
        <td class="num">${fmt((a.calc && a.calc.valoareIntrare) || a.cost)}${
  a.calc && a.calc.investitii ? `<br><span class="muted">din care investiții ${fmt(a.calc.investitii)}</span>` : ''}</td>
        <td class="num">${fmt(a.calc.amortizareLunara)}</td>
        <td class="num">${fmt(a.calc.amortizareCumulata)}</td>
        <td class="num">${fmt(a.calc.valoareRamasa)}</td>
        <td><a class="linkbtn" href="/pdf/asset/${a.id}?asOf=${asOf}" target="_blank">fișă</a>
          ${a.status !== 'casat' ? ` · <button class="linkbtn amf-inv" data-id="${a.id}" data-nume="${H(a.denumire)}">modernizare</button>` : ''}
          ${a.status !== 'casat' ? ` · <button class="linkbtn amf-scrap" data-id="${a.id}">casează</button>` : ''}
          · <button class="linkbtn amf-del" data-id="${a.id}">șterge</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Niciun mijloc fix înregistrat.</p>';
  $$('#assetsList .amf-del').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmAction('Mijlocul fix va fi eliminat definitiv.', { title: 'Ștergi mijlocul fix?', confirmLabel: 'Șterge', danger: true })) return;
    await api('/api/assets/' + b.dataset.id, { method: 'DELETE' }); loadAssets(); toast('Mijloc fix șters');
  }));
  $$('#assetsList .amf-inv').forEach((b) => b.addEventListener('click', () => deschideInvestitii(b.dataset.id, b.dataset.nume)));
  $$('#assetsList .amf-scrap').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/assets/' + b.dataset.id + '/scrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    loadAssets(); toast('Mijloc fix casat');
  }));
}
// ───────── Investitii ulterioare (modernizari) ─────────
// Planul de amortizare se recalculeaza pe SERVER; aici doar se inregistreaza investitia si se
// reincarca registrul. Lista investitiilor existente se arata sub formular, ca sa se vada din ce
// se compune valoarea de intrare majorata.
async function deschideInvestitii(id, nume, options = {}) {
  const box = $('#mfInvBox'); if (!box) return;
  box.classList.remove('hidden');
  $('#mfInvNume').textContent = nume || '';
  const f = $('#mfInvForm');
  formFlowFlush(f);
  f.reset(); f.assetId.value = id;
  formFlowLoaded(f, 'activ:' + id, { restore: options.restoreDraft !== false });
  const lista = await api('/api/assets?asOf=' + mfAsOf()).catch(() => []);
  const a = (Array.isArray(lista) ? lista : (lista.items || [])).find((x) => x.id === id) || {};
  const inv = a.investitii || [];
  $('#mfInvList').innerHTML = inv.length
    ? `<table><thead><tr><th>Data</th><th class="num">Valoare</th><th>Document</th><th>Descriere</th><th></th></tr></thead><tbody>${
      inv.map((x) => `<tr><td>${H(x.data)}</td><td class="num">${fmt(x.suma)}</td><td>${H(x.document || '')}</td>
        <td>${H(x.descriere || '')}</td>
        <td><button class="linkbtn mfinv-del" data-id="${H(id)}" data-inv="${H(x.id)}">șterge</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio investiție înregistrată la acest mijloc fix.</p>';
  $$('#mfInvList .mfinv-del').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmAction('Investiția va fi eliminată, iar planul de amortizare va fi recalculat.', { title: 'Ștergi investiția?', confirmLabel: 'Șterge și recalculează', danger: true })) return;
    try {
      await api('/api/assets/' + b.dataset.id + '/investitii/' + b.dataset.inv, { method: 'DELETE' });
      toast('Investiție ștearsă'); deschideInvestitii(id, nume); loadAssets();
    } catch (e) { toast(e.message, true); }
  }));
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('#mfInvClose') && $('#mfInvClose').addEventListener('click', () => { formFlowFlush($('#mfInvForm')); $('#mfInvBox').classList.add('hidden'); });
$('#mfInvForm') && $('#mfInvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { data: f.data.value, suma: f.suma.value, document: f.document.value, descriere: f.descriere.value };
  // Prelungirea se trimite doar cand a fost ceruta: pe un activ inca in amortizare n-are ce cauta.
  if (f.durataSuplimentaraLuni.value) body.durataSuplimentaraLuni = f.durataSuplimentaraLuni.value;
  try {
    const r = await api('/api/assets/' + f.assetId.value + '/investitii', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    formFlowSaved(f);
    toast('Investiție înregistrată — valoare de intrare ' + fmt((r.calc || {}).valoareIntrare || 0) + ' lei');
    deschideInvestitii(f.assetId.value, $('#mfInvNume').textContent);
    loadAssets();
  } catch (err) { toast(err.message, true); }
});
onPeriodChange('mf', loadAssets);

// ───────── Catalogul duratelor normale de functionare (HG 2139/2004) ─────────
// Ajutor de completare pentru `durataLuni`, cel mai frecvent gresit camp al formularului: intra
// direct in amortizare, deci in cheltuiala si in impozit, ani la rand si fara sa se vada.
//
// SUGESTIE, NU IMPUNERE: se afiseaza INTERVALUL legal, iar utilizatorul apasa capatul pe care il
// alege. Nu completam noi o valoare „recomandata" — alegerea din interval e o optiune fiscala
// (mai scurt = amortizare mai rapida = impozit mai mic acum) si ramane a contabilului.
//
// Panoul apare doar daca adminul a incarcat catalogul: fara date, un camp de cautare care nu
// gaseste niciodata nimic arata ca o functie stricata.
async function initCatalogDurate() {
  const box = $('#cdBox'); const q = $('#cdQ'); const rez = $('#cdRez');
  if (!box || !q || !rez) return;
  try {
    const r = await api('/api/catalog-durate');
    if (!r || !r.total) return; // catalog neincarcat — panoul ramane ascuns
    box.classList.remove('hidden');
  } catch (e) { return; } // fara catalog, formularul merge exact ca inainte
  let t = null;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const text = q.value.trim();
      if (text.length < 2) { rez.innerHTML = ''; return; }
      try {
        const r = await api('/api/catalog-durate?q=' + encodeURIComponent(text));
        rez.innerHTML = r.rezultate.length
          ? `<table><thead><tr><th>Cod</th><th>Denumire</th><th class="num">Interval legal</th><th>Pune în formular</th></tr></thead><tbody>${
            r.rezultate.map((it) => {
              const lmin = Math.round(it.aniMin * 12); const lmax = Math.round(it.aniMax * 12);
              return `<tr><td class="acc">${H(it.cod)}</td><td>${H(it.denumire)}</td>
                <td class="num">${H(String(it.aniMin))}–${H(String(it.aniMax))} ani</td>
                <td><button type="button" class="linkbtn cd-set" data-luni="${lmin}">${lmin} luni</button>${
                  lmax !== lmin ? ` · <button type="button" class="linkbtn cd-set" data-luni="${lmax}">${lmax} luni</button>` : ''}</td></tr>`;
            }).join('')}</tbody></table>`
          : '<p class="muted">Niciun cod potrivit.</p>';
      } catch (e) { rez.innerHTML = '<p class="muted">Căutarea nu a răspuns.</p>'; }
    }, 250);
  });
  // Delegare: tabelul se redeseneaza la fiecare cautare, deci ascultatorii pusi pe randuri ar
  // trebui relegati de fiecare data (si s-ar acumula daca uiti sa-i scoti).
  rez.addEventListener('click', (e) => {
    const b = e.target.closest('.cd-set'); if (!b) return;
    const f = $('#assetForm'); if (!f || !f.durataLuni) return;
    f.durataLuni.value = b.dataset.luni;
    f.durataLuni.focus();
    toast('Durata completată: ' + b.dataset.luni + ' luni — o poți schimba');
  });
}
initCatalogDurate();

// Importul catalogului (administrator — stare globala, ca planul de conturi).
if ($('#cdCsvFile')) {
  $('#cdCsvFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) { try { $('#cdCsvIn').value = await fileToCsv(f); } catch (err) { toast(err.message, true); } }
  });
}
if ($('#cdImportBtn')) {
  $('#cdImportBtn').addEventListener('click', async () => {
    const csv = ($('#cdCsvIn').value || '').trim();
    if (!csv) return toast('Lipește sau alege un fișier CSV', true);
    const stare = $('#cdImportStare');
    try {
      const r = await api('/api/catalog-durate/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }),
      });
      // Randurile respinse se ARATA, cu numarul liniei. Un catalog incarcat pe jumatate fara sa
      // spuna care jumatate l-ar face pe contabil sa caute degeaba un cod care n-a intrat.
      stare.className = 'status ok';
      stare.innerHTML = `${r.importate} poziții încărcate (${r.total} în catalog).`
        + (r.respinse && r.respinse.length
          ? ` <b>${r.respinse.length} rânduri respinse:</b><br>` + r.respinse
            .map((x) => `linia ${H(String(x.linie))}${x.cod ? ' (' + H(x.cod) + ')' : ''} — ${H(x.motiv)}`).join('<br>')
          : '');
      $('#cdCsvIn').value = '';
      initCatalogDurate(); // catalogul tocmai a devenit disponibil: arata panoul de cautare
    } catch (err) { stare.className = 'status err'; stare.textContent = err.message; }
  });
}
function lsQuery() { const f = $('#lsForm'); return 'principal=' + f.principal.value + '&months=' + f.months.value + '&rate=' + f.rate.value + '&method=' + f.method.value; }
$('#lsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  formFlowFlush(e.target);
  $('#lsPdf').href = '/pdf/leasing-schedule?' + lsQuery();
  const s = await api('/api/leasing-schedule?' + lsQuery());
  $('#lsView').innerHTML = `<table><thead><tr><th class="num">Luna</th><th class="num">Rată</th><th class="num">Principal</th><th class="num">Dobândă</th><th class="num">Sold rămas</th></tr></thead><tbody>${
    s.rows.map((r) => `<tr><td class="num">${r.luna}</td><td class="num">${fmt(r.rata)}</td><td class="num">${fmt(r.principal)}</td><td class="num">${fmt(r.dobanda)}</td><td class="num">${fmt(r.sold)}</td></tr>`).join('')}
    <tr class="bold"><td class="num">TOTAL</td><td class="num">${fmt(s.totals.rata)}</td><td class="num">${fmt(s.totals.principal)}</td><td class="num">${fmt(s.totals.dobanda)}</td><td></td></tr></tbody></table>`;
});
// ───────── Metodele permise pe contul ales (art. 28 alin. (5)) ─────────
// Lista se cere de la SERVER, nu se deduce aici: e o regula care schimba impozitul, iar o a doua
// implementare in frontend ar drifta fata de cea care decide. Serverul refuza oricum metoda
// nepermisa — asta doar nu i-o mai ofera contabilului, si ii spune de ce.
//
// Daca ruta nu raspunde (server vechi, retea), formularul ramane exact ca inainte: toate metodele
// disponibile si nicio explicatie. O sugestie care lipseste nu are voie sa blocheze inregistrarea.
const ETICHETE_METODA = { liniara: 'Liniară', degresiva: 'Degresivă (AD)', accelerata: 'Accelerată (50% an 1)' };
async function actualizeazaMetode() {
  const f = $('#assetForm'); if (!f || !f.cont || !f.metoda) return;
  const stare = $('#mfContStare');
  const cont = (f.cont.value || '').trim();
  const arataStare = (text, clasa) => {
    if (!stare) return;
    stare.textContent = text || '';
    stare.className = 'full status' + (text ? ' ' + clasa : ' hidden');
  };
  const toateVizibile = () => {
    for (const sel of [f.metoda, f.metodaFiscala].filter(Boolean)) {
      for (const o of sel.options) { o.hidden = false; o.disabled = false; }
    }
  };
  if (!cont) { toateVizibile(); arataStare('', ''); return; }
  let r;
  try { r = await api('/api/assets/metode?cont=' + encodeURIComponent(cont) + (f.computer && f.computer.checked ? '&computer=1' : '')); }
  catch (err) { toateVizibile(); arataStare('', ''); return; }
  if (!r.amortizabil) {
    arataStare(r.motiv, 'err');
    return;
  }
  arataStare('Contul de amortizare: ' + r.contAmortizare + (r.permise.length < 3 ? ' · metode permise: ' + r.permise.map((m) => ETICHETE_METODA[m] || m).join(', ') : ''), 'ok');
  for (const sel of [f.metoda, f.metodaFiscala].filter(Boolean)) {
    for (const o of sel.options) {
      const nepermisa = o.value && !r.permise.includes(o.value);
      o.hidden = nepermisa; o.disabled = nepermisa;
    }
    if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) sel.value = r.permise[0] || '';
  }
}
if ($('#assetForm')) {
  const f = $('#assetForm');
  if (f.cont) f.cont.addEventListener('change', actualizeazaMetode);
  if (f.cont) f.cont.addEventListener('blur', actualizeazaMetode);
  if (f.computer) f.computer.addEventListener('change', actualizeazaMetode);
  f.addEventListener('formflow:restored', actualizeazaMetode);
}
function golesteMijlocFix(options = {}) {
  const f = $('#assetForm'); if (!f) return;
  formFlowFlush(f);
  f.reset();
  f.valoareReziduala.value = '0';
  formFlowLoaded(f, 'nou', { restore: options.restoreDraft !== false });
  actualizeazaMetode();
}
window.addEventListener('contab:company-context', () => {
  golesteMijlocFix();
  golesteContractLeasing();
  const investment = $('#mfInvForm');
  if (investment) { formFlowLoaded(investment, 'nou', { restore: false }); $('#mfInvBox').classList.add('hidden'); }
});
$('#assetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { denumire: f.denumire.value, cont: f.cont.value, cost: f.cost.value, durataLuni: f.durataLuni.value, metoda: f.metoda.value, valoareReziduala: f.valoareReziduala.value, dataAchizitie: f.dataAchizitie.value, dataPif: f.dataPif.value, furnizor: f.furnizor.value, cui: f.cui.value };
  // Marcaj explicit, ca `vehiculM1`: schimba metodele permise pe 214 (art. 28 alin. (5) lit. b).
  if (f.computer && f.computer.checked) body.computer = true;
  // Planul fiscal se trimite doar daca a fost ales; serverul ignora oricum valorile egale cu cele
  // contabile, dar nu are rost sa le trimitem.
  if (f.metodaFiscala && f.metodaFiscala.value) body.metodaFiscala = f.metodaFiscala.value;
  if (f.durataFiscalaLuni && f.durataFiscalaLuni.value) body.durataFiscalaLuni = f.durataFiscalaLuni.value;
  // Plafonul auto (art. 28 alin. (12) lit. m) se trimite doar cand e bifat: marcaj explicit.
  if (f.vehiculM1 && f.vehiculM1.checked) body.vehiculM1 = true;
  try {
    await api('/api/assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    formFlowSaved(f);
    toast('Mijloc fix adăugat'); golesteMijlocFix({ restoreDraft: false }); loadAssets();
  }
  catch (err) { toast(err.message, true); }
});
$('#mfDeprec').addEventListener('click', async () => {
  const period = mfAsOf();
  try {
    const r = await api('/api/assets/depreciation?period=' + period, { method: 'POST' });
    toast(r.message || ('Amortizare înregistrată pentru ' + period + ' (' + (r.result.lines || []).length + ' MF)'));
    loadAssets();
  } catch (err) { toast(err.message, true); }
});


// ───────────────────────── CONTRACTE DE LEASING ─────────────────────────
// Nomenclatorul care alimentează factura de rată. Graficul se derivă din contract pe server;
// aici doar se afișează — regula de calcul are o singură implementare.
function golesteContractLeasing(options = {}) {
  const f = $('#lcForm'); if (!f) return;
  formFlowFlush(f);
  f.reset();
  f.id.value = '';
  applyFiscalDefaults(f);
  formFlowLoaded(f, 'nou', { restore: options.restoreDraft !== false });
}
async function loadLeasingContracts() {
  let list = [];
  try { list = await api('/api/leasing-contracts'); } catch (err) { $('#lcList').innerHTML = `<p class="status err">${H(err.message)}</p>`; return; }
  $('#lcList').innerHTML = list.length
    ? `<table><thead><tr><th>Contract</th><th>Locator</th><th class="num">Finanțat</th><th class="num">Rate</th><th class="num">Dobândă</th><th>Perioadă</th><th>Stadiu</th><th class="num">Total dobândă</th><th></th></tr></thead><tbody>${
      list.map((c) => { const u = c.usage || {}; return `<tr><td>${H(c.denumire)}${c.document ? ' <span class="muted">' + H(c.document) + '</span>' : ''}</td><td>${H(c.partener)}</td>
        <td class="num">${fmt(c.principal)}</td><td class="num">${c.months}</td><td class="num">${fmt(c.dobandaAnuala)}%</td>
        <td>${H(c.primaRata || '')} … ${H(c.ultimaRata || '')}</td>
        <td><b>${Number(u.posted) || 0}/${c.months}</b> postate${u.inLucru ? ' · ' + Number(u.inLucru) + ' în lucru' : ''}${u.nextPeriod ? '<br><span class="muted">următoarea: ' + H(u.nextPeriod) + '</span>' : '<br><span class="muted">grafic complet</span>'}</td>
        <td class="num">${fmt(c.totals.dobanda)}</td>
        <td><button class="linkbtn lcgraf" data-id="${H(c.id)}">grafic</button> · <button class="linkbtn lcedit" data-id="${H(c.id)}">editează</button>${u.linked ? ' · <span class="muted" title="Contract folosit: istoricul nu poate fi șters">istoric protejat</span>' : ' · <button class="linkbtn lcdel" data-id="' + H(c.id) + '">șterge</button>'}</td></tr>`; }).join('')}
      </tbody></table>`
    : '<p class="muted">Niciun contract de leasing. Adaugă unul în formular.</p>';
  $('#lcList').dataset.json = JSON.stringify(list);
}
$('#lcForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { id: f.id.value || undefined, denumire: f.denumire.value, partener: f.partener.value, cui: f.cui.value,
    document: f.document.value, principal: f.principal.value, months: f.months.value,
    dobandaAnuala: f.dobandaAnuala.value, dataPrimeiRate: f.dataPrimeiRate.value, cotaTva: f.cotaTva.value, metoda: f.metoda.value };
  try {
    await api('/api/leasing-contracts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    formFlowSaved(f);
    toast('Contract salvat'); golesteContractLeasing({ restoreDraft: false });
    loadLeasingContracts();
  } catch (err) { toast(err.message, true); }
});
$('#lcList').addEventListener('click', async (e) => {
  const id = e.target.dataset.id; if (!id) return;
  const list = JSON.parse($('#lcList').dataset.json || '[]');
  const c = list.find((x) => x.id === id); if (!c) return;
  if (e.target.classList.contains('lcedit')) {
    const f = $('#lcForm');
    formFlowFlush(f);
    for (const k of ['id', 'denumire', 'partener', 'cui', 'document', 'principal', 'months', 'dobandaAnuala', 'dataPrimeiRate', 'cotaTva', 'metoda']) if (f[k]) f[k].value = c[k] != null ? c[k] : '';
    formFlowLoaded(f, 'contract:' + c.id);
    f.scrollIntoView({ block: 'center' });
  } else if (e.target.classList.contains('lcdel')) {
    if (!await confirmAction('Contractul „' + c.denumire + '” va fi eliminat definitiv.', { title: 'Ștergi contractul?', confirmLabel: 'Șterge', danger: true })) return;
    try {
      await api('/api/leasing-contracts/' + encodeURIComponent(id), { method: 'DELETE' });
      const f = $('#lcForm');
      if (f.id.value === id) { formFlowDiscard(f); golesteContractLeasing({ restoreDraft: false }); }
      toast('Contract șters'); loadLeasingContracts(); $('#lcSchedule').innerHTML = '';
    } catch (err) { toast(err.message, true); }
  } else if (e.target.classList.contains('lcgraf')) {
    try {
      const r = await api('/api/leasing-contracts/' + encodeURIComponent(id) + '/schedule');
      $('#lcSchedule').innerHTML = `<h3>Grafic — ${H(c.denumire)}</h3><table><thead><tr><th class="num">Luna</th><th>Perioadă</th><th class="num">Rată</th><th class="num">Principal</th><th class="num">Dobândă</th><th class="num">TVA</th><th class="num">Sold rămas</th><th>Înregistrare</th></tr></thead><tbody>${
        r.schedule.rows.map((x) => `<tr><td class="num">${x.luna}</td><td>${H(x.period || '')}</td><td class="num">${fmt(x.rata)}</td><td class="num">${fmt(x.principal)}</td><td class="num">${fmt(x.dobanda)}</td><td class="num">${fmt(x.tva)}</td><td class="num">${fmt(x.sold)}</td><td>${x.inregistrare ? '<b>' + H(x.inregistrare.document || x.inregistrare.id) + '</b><br><span class="muted">' + H(x.inregistrare.status) + ' · ' + H(x.inregistrare.data) + '</span>' : '<span class="muted">neînregistrată</span>'}</td></tr>`).join('')}
        <tr class="bold"><td colspan="2">TOTAL</td><td class="num">${fmt(r.schedule.totals.rata)}</td><td class="num">${fmt(r.schedule.totals.principal)}</td><td class="num">${fmt(r.schedule.totals.dobanda)}</td><td class="num">${fmt(r.schedule.totals.tva)}</td><td colspan="2"></td></tr></tbody></table>`;
    } catch (err) { toast(err.message, true); }
  }
});

registerFormFlow({
  form: '#mfInvForm',
  title: 'Investiția ulterioară',
  firstStepTitle: 'Data și valoarea investiției',
  entityKey: 'nou',
  progressFields: ['data', 'suma', 'document', 'descriere'],
  onDiscard: (form) => deschideInvestitii(form.assetId.value, $('#mfInvNume').textContent, { restoreDraft: false }),
});

registerFormFlow({
  form: '#assetForm',
  title: 'Înregistrarea mijlocului fix',
  firstStepTitle: 'Identificare și valoare',
  entityKey: 'nou',
  progressFields: ['denumire', 'cont', 'cost', 'durataLuni', 'metoda', 'dataPif'],
  onDiscard: () => golesteMijlocFix({ restoreDraft: false }),
});

registerFormFlow({
  form: '#lcForm',
  title: 'Contractul de leasing',
  firstStepTitle: 'Contract și locator',
  entityKey: 'nou',
  progressFields: ['denumire', 'principal', 'months', 'dataPrimeiRate', 'dobandaAnuala', 'cotaTva', 'metoda'],
  onDiscard: () => golesteContractLeasing({ restoreDraft: false }),
});

function resetLeasingSimulator(options = {}) {
  const form = $('#lsForm'); if (!form) return;
  formFlowFlush(form);
  form.reset();
  formFlowLoaded(form, 'simulator', { restore: options.restoreDraft !== false });
  $('#lsView').innerHTML = ''; $('#lsPdf').removeAttribute('href');
}
registerFormFlow({
  form: '#lsForm',
  title: 'Simulatorul graficului de rate',
  firstStepTitle: 'Finanțare și durată',
  companyKey: () => 'global',
  entityKey: 'simulator',
  progressFields: ['principal', 'months', 'rate', 'method'],
  onDiscard: () => resetLeasingSimulator({ restoreDraft: false }),
});
formFlowLoaded($('#lsForm'), 'simulator');

export { loadAssets, loadLeasingContracts };
