'use strict';

// Salarizare: angajati, stat de plata, fluturasi, registru. Extras din app.js (Etapa: spargerea fisierului mare).
import { $$, $, H, fmt, toast, api, round2, fiscalPct, ac, confirmAction } from './core.js';
import { pget, onPeriodChange } from './periods.js';
import { loadEntries } from './entries.js'; // apelat mai jos; fara import = ReferenceError
import { registerFormFlow, formFlowFlush, formFlowLoaded, formFlowSaved } from './formflow.js';

// Salariile stau in trei pagini (statul de plata, angajatii, registrul anual), deci butoanele care
// trec de la una la alta au nevoie de `goTab` — vine din app.js, ca la entries/docflow (fara ciclu).
const D = { goTab: null };
function setSalarizareDeps(d) { Object.assign(D, d); }
function duLa(tab) { if (D.goTab) D.goTab(tab); }

const CAMPURI_CERT_CM = ['zileCM', 'dataInceputCM', 'procentCM', 'codIndemnizatieCM', 'serieCM',
  'numarCM', 'serieInitialCM', 'numarInitialCM', 'cmDiferentaAngajator', 'cmDiferentaFnuass',
  'dataAcordareCM', 'dataInceputCertificatCM', 'dataSfarsitCM', 'locPrescriereCM', 'codBoalaCM',
  'cnpCopilCM', 'cnpPacientOncologicCM', 'codUrgentaCM', 'codInfectocontagiosCM',
  'avizMedicExpertCM', 'cmProgramNational', 'cmExceptatZiNeplatita', 'cmIntegralFnuass'];
let certificateCMState = [];
let certificatCMEditat = -1;
const ORDINE_BENEFICII_IMPLICITA = 'mobilitate, hrana, cazare, turism, pensii, '
  + 'pensiiOcupationale, sanatate, sport, telemunca, educatie, dobanda';

function citesteCertificatCM(f) {
  const out = {};
  for (const k of CAMPURI_CERT_CM) {
    if (!f[k]) continue;
    out[k] = f[k].type === 'checkbox' ? f[k].checked : f[k].value;
  }
  return out;
}

function scrieCertificatCM(f, c) {
  const x = c || {};
  for (const k of CAMPURI_CERT_CM) {
    if (!f[k]) continue;
    if (f[k].type === 'checkbox') f[k].checked = !!x[k];
    else if (k === 'procentCM') f[k].value = x[k] || 75;
    else if (k === 'codIndemnizatieCM') f[k].value = x[k] || '01';
    else if (k === 'locPrescriereCM') f[k].value = x[k] || 1;
    else if (['zileCM', 'cmDiferentaAngajator', 'cmDiferentaFnuass'].includes(k)) f[k].value = x[k] || 0;
    else f[k].value = x[k] || '';
  }
}

function randuriIstoricCM(text) {
  return String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((linie) => {
    const p = linie.split(/[;,\t]/).map((x) => x.trim());
    return { period: p[0] || '', venit: p[1] || '', zile: p[2] || '' };
  });
}

function textIstoricCM(rows) {
  return (rows || []).map((x) => [x.period, x.venit, x.zile].join('; ')).join('\n');
}

function ordineBeneficiiDinText(text) {
  return String(text || '').split(/[;,\s]+/).map((x) => x.trim()).filter(Boolean);
}

function renderCertificateCM() {
  const box = $('#cmCertificateList'); if (!box) return;
  box.innerHTML = certificateCMState.length ? certificateCMState.map((c, i) =>
    `<div class="cm-cert-item${i === certificatCMEditat ? ' active' : ''}"><span class="cm-cert-desc"><b>${i + 1}. ${H(c.serieCM || 'fără serie')} / ${H(c.numarCM || 'fără număr')}</b> · cod ${H(c.codIndemnizatieCM || '01')} · ${Number(c.zileCM) || 0} zile · ${Number(c.procentCM) || 0}%</span><button class="linkbtn cm-cert-edit" type="button" data-i="${i}">editează</button><button class="linkbtn cm-cert-del" type="button" data-i="${i}">elimină</button></div>`).join('')
    : '<span class="muted">Niciun certificat adăugat.</span>';
  box.querySelectorAll('.cm-cert-edit').forEach((b) => b.addEventListener('click', () => {
    certificatCMEditat = Number(b.dataset.i);
    scrieCertificatCM($('#angajatForm'), certificateCMState[certificatCMEditat]);
    renderCertificateCM();
  }));
  box.querySelectorAll('.cm-cert-del').forEach((b) => b.addEventListener('click', () => {
    const i = Number(b.dataset.i); certificateCMState.splice(i, 1);
    if (certificatCMEditat === i) { certificatCMEditat = -1; scrieCertificatCM($('#angajatForm'), null); }
    else if (certificatCMEditat > i) certificatCMEditat -= 1;
    renderCertificateCM();
  }));
}

function adaugaActualizeazaCertificatCM(showToast = true) {
  const f = $('#angajatForm'); const c = citesteCertificatCM(f);
  if (!(Number(c.zileCM) > 0)) {
    if (showToast) toast('Completează numărul de zile al certificatului.', true);
    return false;
  }
  if (certificatCMEditat >= 0) certificateCMState[certificatCMEditat] = c;
  else if (certificateCMState.length < 10) certificateCMState.push(c);
  else { if (showToast) toast('Poți adăuga maximum 10 certificate într-o lună.', true); return false; }
  certificatCMEditat = -1; scrieCertificatCM(f, null); renderCertificateCM();
  if (showToast) toast('Certificat adăugat în lista lunii. Salvează și fișa angajatului.');
  return true;
}

/** Campurile categoriilor din plafonul de 33% (art. 76 alin. (4^1)), citite DIN FORMULAR.
 *  Nomenclatorul nu se copiaza aici: o categorie noua inseamna un `<input name="ben_*">` in
 *  index.html plus o linie in `BENEFICII` din fiscalConfig.js, si nimic altceva in frontend —
 *  o a treia lista, tinuta de mana, ar fi cea care ramane in urma. */
function campuriBeneficii(form) {
  return Array.from((form || document).querySelectorAll('input[name^="ben_"]'));
}

/** Textul din tooltipul insignei de beneficii: plafonul, ce a incaput si de ce a iesit restul.
 *  Merge prin `H()` la afisare — e text pentru un ATRIBUT title, deci ghilimelele contează. */
function insignaBeneficii(r) {
  const linii = [
    'Art. 76 alin. (4¹): plafon 33% din salariul de bază = ' + fmt(r.beneficiiPlafon) + ' lei',
    'Acordat ' + fmt(r.beneficiiAcordate) + ' · neimpozabil ' + fmt(r.beneficiiNeimpozabile)
      + ' · impozabil ' + fmt(r.beneficiiImpozabile) + ' · rămas ' + fmt(r.beneficiiRamas),
  ];
  for (const b of r.beneficii || []) {
    const lim = b.limitaIndividuala == null ? 'fără limită proprie' : 'limită ' + fmt(b.limitaIndividuala);
    linii.push('• ' + b.lit + ') ' + b.nume + ': ' + fmt(b.acordat) + ' (' + lim + ')'
      + (b.impozabil ? ' → impozabil ' + fmt(b.impozabil) : ''));
  }
  if (r.beneficiiCursNecesar) linii.push('Curs EUR ' + fmt(r.cursEurBeneficii) + ' · '
    + (r.cursEurBeneficiiSursa === 'bnr' ? 'BNR ' + (r.cursEurBeneficiiData || '') : 'valoare implicită'));
  if (r.beneficiiCursAproximat) linii.push('⚠ Cursul EUR nu este definitiv; statul nu poate fi postat.');
  if (r.beneficiiOrdineNecesara && !r.beneficiiOrdineConfirmata) {
    linii.push('⚠ Ordinea de includere nu este confirmată de angajator; statul nu poate fi postat.');
  }
  return linii.join('\n');
}

function insignaCM(r) {
  const certificate = Array.isArray(r.certificateCM) && r.certificateCM.length ? r.certificateCM : [r];
  const linii = [
    certificate.length + (certificate.length === 1 ? ' certificat' : ' certificate') + ': '
      + r.zileCM + ' zile înscrise, ' + (r.zilePlatiteCM || 0) + ' plătite'
      + (r.zileNeplatiteCM ? ', ' + r.zileNeplatiteCM + ' neplătite' : ''),
    'Bază zilnică ' + fmt(r.mediaZilnicaCM) + ' lei',
    'Total angajator ' + (r.zileCMAngajator || 0) + ' zile / ' + fmt(r.cmAngajator)
      + ' lei · FNUASS ' + Math.max(0, (r.zilePlatiteCM || 0) - (r.zileCMAngajator || 0))
      + ' zile / ' + fmt(r.cmFnuass) + ' lei',
  ];
  for (const c of certificate) linii.push('• ' + (c.serieCM || '') + '/' + (c.numarCM || '')
    + ' · cod ' + (c.codIndemnizatieCM || '01') + ' · ' + c.zileCM + ' zile · '
    + (c.procentCM || 0) + '%');
  if (r.cmBazaAproximata) linii.push('⚠ Baza este aproximată: lipsesc suficiente state istorice.');
  if (r.cmAproximat) linii.push('⚠ Repartizarea zilelor este aproximată: lipsește data episodului.');
  if (r.cmDiferentaAngajator || r.cmDiferentaFnuass) linii.push('Diferență recalculată pentru luna anterioară: '
    + fmt((r.cmDiferentaAngajator || 0) + (r.cmDiferentaFnuass || 0)) + ' lei.');
  return linii.join('\n');
}

// ───────────────────────── SALARIZARE ─────────────────────────
function spPeriod() { return pget('sp') || new Date().toISOString().slice(0, 7); }
async function loadSalarizare() {
  $('#spPdf').href = '/pdf/stat-plata?period=' + spPeriod();
  $('#spD112').href = '/xml/d112?period=' + spPeriod();
  $('#spDosarCm') && ($('#spDosarCm').href = '/pdf/dosar-cm?period=' + spPeriod());
  const p = encodeURIComponent(spPeriod());
  const [sp, spLive] = await Promise.all([
    api('/api/stat-plata?period=' + p),
    api('/api/stat-plata?period=' + p + '&live=1'),
  ]);
  const liveById = new Map(spLive.rows.map((r) => [r.angajatId || r.id, r]));
  const t = sp.totals;
  const postBtn = $('#spPost'); const payBtn = $('#spPay');
  postBtn.disabled = !!sp.postat;
  postBtn.textContent = sp.postat ? 'Stat înregistrat' : 'Înregistrează salariile lunii';
  payBtn.disabled = !sp.postat || !!sp.platit;
  payBtn.textContent = sp.platit ? 'Salarii plătite' : 'Plătește salariile';
  $('#spState').innerHTML = sp.postat
    ? '<span class="pill">✓ fotografie postată</span>'
      + (sp.platit ? ' <span class="pill">✓ plată înregistrată</span>' : ' · plata nu este încă înregistrată')
    : '<span class="pill warn">ciornă live</span> · postează statul înainte de plată; după storno, fotografia veche nu mai este folosită';
  $('#angajatiList').innerHTML = sp.rows.length
    ? `<table><thead><tr><th>Nume</th><th>Funcție</th><th class="num">Brut</th><th class="num">CAS</th><th class="num">CASS</th><th class="num">Deducere</th><th class="num">Impozit</th><th class="num">Net</th><th class="num">Avans</th><th class="num">Rețineri</th><th class="num">Rest plată</th><th class="num">CAM</th><th></th></tr></thead><tbody>${
      sp.rows.map((r) => `<tr><td>${H(r.nume)}${r.spor ? ' <span class="muted">+spor ' + fmt(r.spor) + '</span>' : ''}${r.persoane ? ' <span class="muted">' + r.persoane + ' pers.</span>' : ''}${r.tichete ? ' <span class="muted">+tichete ' + fmt(r.tichete) + '</span>' : ''}${r.avantaje ? ' <span class="muted" title="Avantaje în natură impozabile — intră în CAS/CASS/impozit, nu se plătesc în bani">+avantaje ' + fmt(r.avantaje) + '</span>' : ''}${r.zileCM ? ' <span class="muted" title="' + H(insignaCM(r)) + '">' + (r.cmBazaAproximata || r.cmAproximat ? '⚠' : '🏥') + ' CM ' + r.zileCM + 'z</span>' : ''}${r.zileCO ? ' <span class="muted" title="Concediu de odihnă: ' + r.zileCO + ' zile, indemnizație ' + fmt(r.indemnizatieCO) + ' lei pe media 3 luni (' + fmt(r.mediaCO) + ')">🏖 CO ' + r.zileCO + 'z</span>' : ''}${r.normaPartiala ? ' <span class="muted" title="Normă parțială sub salariul minim: CAS ' + fmt(r.casAngajator) + ' + CASS ' + fmt(r.cassAngajator) + ' suportate suplimentar de firmă (OUG 16/2022)">⏱ parțial</span>' : ''}${r.neimpozabilMinim ? ' <span class="muted" title="Art. 76 Cod fiscal: ' + fmt(r.neimpozabilMinim) + ' lei din salariul minim sunt neimpozabili ȘI exceptați de la CAS/CASS/CAM — de aceea contribuțiile sunt calculate la o bază mai mică decât brutul">✓ ' + fmt(r.neimpozabilMinim) + ' lei neimpozabili</span>' : ''}${r.beneficiiAcordate ? ' <span class="muted" title="' + H(insignaBeneficii(r)) + '">' + (r.beneficiiDepasit ? '⚠' : '✓') + ' beneficii ' + fmt(r.beneficiiNeimpozabile) + ' neimpozabil' + (r.beneficiiImpozabile ? ' / ' + fmt(r.beneficiiImpozabile) + ' impozabil' : '') + '</span>' : ''}${r.scutire ? ' <span class="muted">scutit (' + H(r.sector) + ')</span>' : ''}${r.overPlafon ? ' <span data-u="u13">⚠ peste plafon scutire</span>' : ''}</td><td>${H(r.functie)}</td>
        <td class="num">${fmt(r.brut)}</td><td class="num">${fmt(r.cas)}</td><td class="num">${fmt(r.cass)}</td><td class="num">${r.deducere ? fmt(r.deducere) : ''}</td><td class="num">${fmt(r.impozit)}</td><td class="num">${fmt(r.net)}</td><td class="num">${r.avans ? fmt(r.avans) : ''}</td><td class="num">${r.retineri ? fmt(r.retineri) : ''}</td><td class="num">${fmt(r.restPlata)}</td><td class="num">${fmt(r.cam)}</td>
        <td><a class="linkbtn" href="/pdf/fluturas/${r.angajatId || r.id}?period=${spPeriod()}" target="_blank">fluturaș</a> · <a class="linkbtn" href="/pdf/adeverinta/${r.angajatId || r.id}?year=${($('#rsYear').value || new Date().getFullYear())}" target="_blank">adeverință</a>${liveById.has(r.angajatId || r.id) ? ' · <button class="linkbtn aedit" data-id="' + H(r.angajatId || r.id) + '">editează</button> · <button class="linkbtn adel" data-id="' + H(r.angajatId || r.id) + '">șterge</button>' : ''}</td></tr>`).join('')}
      <tr class="bold"><td colspan="2">TOTAL (${sp.rows.length} ang.)</td><td class="num">${fmt(t.brut)}</td><td class="num">${fmt(t.cas)}</td><td class="num">${fmt(t.cass)}</td><td class="num">${fmt(t.deducere)}</td><td class="num">${fmt(t.impozit)}</td><td class="num">${fmt(t.net)}</td><td class="num">${fmt(t.avans)}</td><td class="num">${fmt(t.retineri)}</td><td class="num">${fmt(t.restPlata)}</td><td class="num">${fmt(t.cam)}</td><td></td></tr></tbody></table>`
    : '<p class="muted">Niciun angajat. Adaugă unul în pagina „Angajați" (butonul de mai sus).</p>';
  $('#spSummary').innerHTML = `<table><tbody>
    <tr><td>Total salarii brute${ac('641')}</td><td class="num">${fmt(t.brut)}</td></tr>
    <tr><td>CAS ${fiscalPct('cas', 25)} reținut${ac('4315')}</td><td class="num">${fmt(t.cas)}</td></tr>
    <tr><td>CASS ${fiscalPct('cass', 10)} reținut${ac('4316')}</td><td class="num">${fmt(t.cass)}</td></tr>
    <tr><td>Impozit ${fiscalPct('impozitVenit', 10)}${ac('444')}</td><td class="num">${fmt(t.impozit)}</td></tr>
    <tr><td>CAM ${fiscalPct('cam', 2.25)} angajator${ac('436')}</td><td class="num">${fmt(t.cam)}</td></tr>
    <tr class="bold"><td>Salarii nete de plată${ac('421')}</td><td class="num">${fmt(t.net)}</td></tr>
    <tr class="bold"><td>Total de virat la buget</td><td class="num">${fmt(t.totalBuget)}</td></tr>
    <tr><td>Cost total angajator</td><td class="num">${fmt(t.costTotal)}</td></tr></tbody></table>`;
  $$('#angajatiList .adel').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmAction('Angajatul va fi eliminat din nomenclator. Statele deja generate rămân înregistrate.', { title: 'Ștergi angajatul?', confirmLabel: 'Șterge', danger: true })) return;
    await api('/api/angajati/' + b.dataset.id, { method: 'DELETE' }); loadSalarizare(); toast('Angajat șters');
  }));
  if (!$('#rsYear').value) $('#rsYear').value = (new Date()).getFullYear();
  renderRegistruSalarii();
  $$('#angajatiList .aedit').forEach((b) => b.addEventListener('click', () => {
    const r = liveById.get(b.dataset.id); const f = $('#angajatForm');
    // Înainte de a pune alt angajat în aceleași controale, finalizează debounce-ul ciornei curente.
    formFlowFlush(f);
    // formularul e in ALTA pagina de cand salariile s-au spart in trei: fara saltul asta, „editează"
    // ar completa un formular pe care utilizatorul nu-l vede si ar parea ca butonul nu face nimic
    duLa('angajati');
    f.id.value = r.id; f.nume.value = r.nume; f.cnp.value = r.cnp; f.functie.value = r.functie;
    f.salariuBrut.value = round2(r.brut - r.spor); f.spor.value = r.spor; f.neimpozabil.value = r.neimpozabil; f.avans.value = r.avans; f.retineri.value = r.retineri;
    f.persoane.value = r.persoane != null ? r.persoane : 0; f.copii.value = r.copii || 0; f.sub26.checked = !!r.sub26;
  // `undefined` la inregistrarile vechi inseamna functie de baza (vezi payrollService): bifat.
  if (f.functieBaza) f.functieBaza.checked = r.functieBaza !== false;
    f.tichete.value = r.tichete || 0; f.avantaje.value = r.avantaje || 0; f.sector.value = r.sector || 'normal';
    f.salariuBrut.value = round2((r.salariuBaza || r.brut) - r.spor);
    certificateCMState = Array.isArray(r.certificateCM) && r.certificateCM.length
      ? r.certificateCM.map((c) => ({ ...c })) : (r.zileCM ? [{ ...r }] : []);
    certificatCMEditat = certificateCMState.length ? 0 : -1;
    scrieCertificatCM(f, certificateCMState[0] || null); renderCertificateCM();
    f.cmEligibilitate.value = r.cmEligibilitate || '';
    f.cmStagiuDocument.value = r.cmStagiuDocument || '';
    f.cmIstoricBaza.value = textIstoricCM(r.istoricBazaCM || []);
    f.cmBazaPerioadaCompleta.checked = !!r.cmBazaPerioadaCompleta;
    f.zileCO.value = r.zileCO || 0; f.normaPartiala.checked = !!r.normaPartiala; f.scutitNormaPartiala.checked = false;
    // Avantajele art. 76 alin. (4^1): randul poarta doar categoriile ACORDATE, deci se pleaca de la
    // zero pe toate si se completeaza cele gasite — altfel o categorie stearsa ar ramane afisata.
    campuriBeneficii(f).forEach((inp) => { inp.value = 0; });
    for (const b of r.beneficii || []) { if (f['ben_' + b.id]) f['ben_' + b.id].value = b.acordat; }
    f.zileTelemunca.value = r.zileTelemunca || 0; f.copiiCresa.value = r.copiiCresa || 0;
    f.zileMobilitate.value = r.zileMobilitate != null ? r.zileMobilitate : '';
    f.ordineBeneficiiText.value = (r.ordineBeneficii || []).join(', ') || ORDINE_BENEFICII_IMPLICITA;
    f.beneficiiOrdineConfirmata.checked = !!r.beneficiiOrdineConfirmata;
    formFlowLoaded(f, 'angajat:' + r.id);
  }));
}
onPeriodChange('sp', () => { $('#spPdf').href = '/pdf/stat-plata?period=' + spPeriod(); $('#spD112').href = '/xml/d112?period=' + spPeriod(); $('#spDosarCm') && ($('#spDosarCm').href = '/pdf/dosar-cm?period=' + spPeriod()); loadSalarizare(); });
async function renderRegistruSalarii() {
  const y = $('#rsYear').value || (new Date()).getFullYear();
  $('#rsPdf').href = '/pdf/registru-salarii?year=' + y;
  const rs = await api('/api/registru-salarii?year=' + y);
  $('#rsList').innerHTML = rs.angajati.length
    ? `<table><thead><tr><th>Nume</th><th>CNP</th><th class="num">Luni</th><th class="num">Brut anual</th><th class="num">CAS</th><th class="num">CASS</th><th class="num">Impozit</th><th class="num">Net anual</th></tr></thead><tbody>${
      rs.angajati.map((e) => `<tr><td>${H(e.nume)}</td><td class="acc">${H(e.cnp)}</td><td class="num">${e.luni}</td><td class="num">${fmt(e.brut)}</td><td class="num">${fmt(e.cas)}</td><td class="num">${fmt(e.cass)}</td><td class="num">${fmt(e.impozit)}</td><td class="num">${fmt(e.net)}</td></tr>`).join('')}
      <tr class="bold"><td colspan="3">TOTAL (${rs.nrLuni} luni)</td><td class="num">${fmt(rs.totals.brut)}</td><td class="num">${fmt(rs.totals.cas)}</td><td class="num">${fmt(rs.totals.cass)}</td><td class="num">${fmt(rs.totals.impozit)}</td><td class="num">${fmt(rs.totals.net)}</td></tr></tbody></table>`
    : '<p class="muted">Niciun stat de plată înregistrat pentru anul selectat.</p>';
}
$('#rsYear').addEventListener('change', renderRegistruSalarii);
$('#angajatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const beneficii = {};
  campuriBeneficii(f).forEach((inp) => { beneficii[inp.name.slice(4)] = inp.value; });
  if (Number(f.zileCM.value) > 0 && !adaugaActualizeazaCertificatCM(false)) return;
  const body = { id: f.id.value || undefined, nume: f.nume.value, cnp: f.cnp.value, functie: f.functie.value, salariuBrut: f.salariuBrut.value, spor: f.spor.value, persoane: f.persoane.value, copii: f.copii.value, sub26: f.sub26.checked, functieBaza: f.functieBaza ? f.functieBaza.checked : true, neimpozabil: f.neimpozabil.value, tichete: f.tichete.value, avantaje: f.avantaje.value, zileCM: f.zileCM.value, dataInceputCM: f.dataInceputCM.value, procentCM: f.procentCM.value, codIndemnizatieCM: f.codIndemnizatieCM.value, serieCM: f.serieCM.value, numarCM: f.numarCM.value, serieInitialCM: f.serieInitialCM.value, numarInitialCM: f.numarInitialCM.value, cmDiferentaAngajator: f.cmDiferentaAngajator.value, cmDiferentaFnuass: f.cmDiferentaFnuass.value, dataAcordareCM: f.dataAcordareCM.value, dataInceputCertificatCM: f.dataInceputCertificatCM.value, dataSfarsitCM: f.dataSfarsitCM.value, locPrescriereCM: f.locPrescriereCM.value, codBoalaCM: f.codBoalaCM.value, cnpCopilCM: f.cnpCopilCM.value, cnpPacientOncologicCM: f.cnpPacientOncologicCM.value, codUrgentaCM: f.codUrgentaCM.value, codInfectocontagiosCM: f.codInfectocontagiosCM.value, avizMedicExpertCM: f.avizMedicExpertCM.value, cmProgramNational: f.cmProgramNational.checked, cmExceptatZiNeplatita: f.cmExceptatZiNeplatita.checked, cmIntegralFnuass: f.cmIntegralFnuass.checked, zileCO: f.zileCO.value, normaPartiala: f.normaPartiala.checked, scutitNormaPartiala: f.scutitNormaPartiala.checked, zileLucratoare: f.zileLucratoare.value, sector: f.sector.value, avans: f.avans.value, retineri: f.retineri.value,
    certificateCM: certificateCMState.map((c) => ({ ...c })),
    cmEligibilitate: f.cmEligibilitate.value, cmStagiuDocument: f.cmStagiuDocument.value,
    istoricBazaCM: randuriIstoricCM(f.cmIstoricBaza.value),
    cmBazaPerioadaCompleta: f.cmBazaPerioadaCompleta.checked,
    beneficii, zileTelemunca: f.zileTelemunca.value, zileMobilitate: f.zileMobilitate.value,
    copiiCresa: f.copiiCresa.value,
    ordineBeneficii: ordineBeneficiiDinText(f.ordineBeneficiiText.value),
    beneficiiOrdineConfirmata: f.beneficiiOrdineConfirmata.checked };
  try {
    await api('/api/angajati', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    formFlowSaved(f);
    toast('Angajat salvat'); golesteAngajat({ restoreDraft: false }); loadSalarizare();
  }
  catch (err) { toast(err.message, true); }
});
// Golirea formularului: `reset()` intoarce campurile la valorile din HTML, dar `id` e hidden si ar
// ramane completat — adica urmatoarea salvare ar MODIFICA angajatul dinainte in loc sa adauge unul.
function golesteAngajat(options = {}) {
  const f = $('#angajatForm'); if (!f) return;
  formFlowFlush(f);
  f.reset(); f.id.value = '';
  certificateCMState = []; certificatCMEditat = -1; renderCertificateCM();
  f.spor.value = '0'; f.copii.value = '0'; f.sub26.checked = false; f.neimpozabil.value = '0';
  f.avans.value = '0'; f.retineri.value = '0'; f.avantaje.value = '0';
  f.cmDiferentaAngajator.value = '0'; f.cmDiferentaFnuass.value = '0';
  campuriBeneficii(f).forEach((inp) => { inp.value = '0'; });
  f.zileTelemunca.value = '0'; f.copiiCresa.value = '0'; f.zileMobilitate.value = '';
  formFlowLoaded(f, 'nou', { restore: options.restoreDraft !== false });
}
$('#cmCertSalveaza') && $('#cmCertSalveaza').addEventListener('click', () => adaugaActualizeazaCertificatCM());
$('#cmCertGoleste') && $('#cmCertGoleste').addEventListener('click', () => {
  certificatCMEditat = -1; scrieCertificatCM($('#angajatForm'), null); renderCertificateCM();
});
$('#angajatNou') && $('#angajatNou').addEventListener('click', () => { golesteAngajat(); toast('Formular gol — completează noul angajat'); });
window.addEventListener('contab:company-context', () => golesteAngajat());
$('#angajatStat') && $('#angajatStat').addEventListener('click', () => duLa('salarizare'));
$('#spAddAngajat') && $('#spAddAngajat').addEventListener('click', () => duLa('angajati'));
$('#spPost').addEventListener('click', async () => {
  const period = spPeriod();
  if (!period) return toast('Alege luna', true);
  try { const r = await api('/api/stat-plata?period=' + period, { method: 'POST' }); toast('Salarii înregistrate: net ' + fmt(r.totals.net) + ', de virat ' + fmt(r.totals.totalBuget)); await Promise.all([loadEntries(), loadSalarizare()]); }
  catch (e) { toast(e.message, true); }
});
$('#spPay').addEventListener('click', async () => {
  const period = spPeriod();
  if (!period) return toast('Alege luna', true);
  try { const r = await api('/api/stat-plata/pay?period=' + period + '&cont=' + $('#spCont').value, { method: 'POST' }); toast('Plătit ' + fmt(r.suma) + ' din contul ' + r.cont + ' (421 = ' + r.cont + ')'); await Promise.all([loadEntries(), loadSalarizare()]); }
  catch (e) { toast(e.message, true); }
});

registerFormFlow({
  form: '#angajatForm',
  title: 'Datele angajatului',
  firstStepTitle: 'Identitate și contract',
  entityKey: 'nou',
  progressFields: ['nume', 'functie', 'salariuBrut', 'sector', 'zileLucratoare', 'procentCM', 'persoane'],
  onDiscard: () => golesteAngajat({ restoreDraft: false }),
});


export { loadSalarizare, setSalarizareDeps };
