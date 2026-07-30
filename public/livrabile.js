'use strict';

// Declaratii & termene: livrabile ANAF, registrul depunerilor, fisa rol/SPV, portofoliu, notificari, reconciliere, scadentar. Extras din app.js (Etapa: spargerea fisierului mare).
import { $$, $, H, fmt, accName, toast, api } from './core.js';
import { pget, onPeriodChange } from './periods.js';

// ───────────────────────── LIVRABILE ─────────────────────────
onPeriodChange('livrabile', loadLivrabile);
const STATUS = {
  ok: { t: 'disponibil', c: 'var(--accent)', bg: '#eef6f2' },
  recap: { t: 'recap (→ ANAF)', c: '#8a6d00', bg: '#fdf6e3' },
  regim: { t: 'după regim', c: '#5a4', bg: '#eef6f2' },
  anaf: { t: 'emis de ANAF', c: '#6b7280', bg: '#eef1f7' },
  manual: { t: 'pregătit de firmă', c: '#6b7280', bg: '#eef1f7' },
};
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
  $('#livrabileSumar').innerHTML =
    `<div class="card"><h3>Sumar fiscal — ${p}</h3><table>
      <tr><td>Salarii brute</td><td class="num">${fmt(s.d112.brut)}</td></tr>
      <tr><td>Total de virat (D112)</td><td class="num">${fmt(s.d112.totalBuget)}</td></tr>
      <tr><td>${de[0]} (D300)</td><td class="num">${fmt(de[1])}</td></tr>
      ${s.du
    ? `<tr><td>Taxe PFA — Declarația Unică (estimare an)</td><td class="num">${fmt(s.du.total)}</td></tr>`
    : `<tr><td>Impozit micro ${s.d100.cota || 1}% (D100, trim.)</td><td class="num">${fmt(s.d100.impozit)}</td></tr>`}
     </table>
     ${!s.du && (s.d100.avertismente || []).length
    ? `<div class="warnbox" data-u="u23"><span class="wi">⚠️</span><div><b>Eligibilitate micro:</b> ${s.d100.avertismente.join('<br>')}</div></div>`
    : ''}</div>
     <div class="card"><h3>Total de virat la ANAF (luna ${p})</h3><table>
      ${s.obligatii.items.map((i) => `<tr><td>${H(i.cont)} ${H(i.nume)}</td><td class="num">${fmt(i.suma)}</td></tr>`).join('') || '<tr><td class="muted">Fără obligații în perioadă</td><td></td></tr>'}
      <tr class="total"><td>TOTAL</td><td class="num">${fmt(s.obligatii.total)}</td></tr>
     </table></div>`;
  $('#livrabileLegend').innerHTML = Object.keys(STATUS).map((k) =>
    `<span data-u="u146"><b data-style="color:${STATUS[k].c}">●</b> ${STATUS[k].t}</span>`).join('');
  const badge = (st) => { const x = STATUS[st] || STATUS.manual; return `<span data-style="background:${x.bg};color:${x.c};border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;white-space:nowrap">${x.t}</span>`; };
  let sec = '';
  const rows = data.list.map((it) => {
    const head = it.sectiune !== sec ? (sec = it.sectiune, `<tr><td colspan="4" data-u="u147">${it.sectiune}</td></tr>`) : '';
    const links = it.links.map((l) => `<a class="linkbtn" href="${l.href}" target="_blank">${l.label}</a>`).join(' · ') || '<span class="muted">—</span>';
    return head + `<tr><td>${it.nr}</td><td>${H(it.nume)}${it.obs ? `<br><span class="muted" data-u="u148">${H(it.obs)}</span>` : ''}</td><td>${badge(it.status)}</td><td>${links}</td></tr>`;
  }).join('');
  $('#livrabileList').innerHTML = `<table><thead><tr><th>#</th><th>Document / declarație</th><th>Statut</th><th>Descărcare</th></tr></thead><tbody>${rows}</tbody></table>`;
  loadDeclRegister(p);
}

// ───────────────────────── REGISTRUL DEPUNERILOR ─────────────────────────
const DECL_ST = {
  nedepusa: { t: 'Nedepusă', c: '#b26a00', bg: '#fff4e0' },
  generata: { t: 'Generată', c: '#1652d6', bg: '#e7eefc' },
  depusa: { t: 'Depusă', c: '#0a7d33', bg: '#e2f5e8' },
  eroare: { t: 'Eroare', c: '#b00020', bg: '#fde7ea' },
  scutita: { t: 'Scutită', c: '#5a6472', bg: '#eceff3' },
  netrimisa: { t: 'Netrimisă în SPV', c: '#b00020', bg: '#fde7ea' },
};
// Sensul inregistrarii de provizion depinde de SEMN: se CONSTITUIE cand mai e nevoie de
// provizion (6814 = 491) si se RELUA cand cel existent e prea mare (491 = 7814). O inversare
// aici arata contabilului exact articolul invers fata de cel corect.
const provizionDirectie = (deAjustat) => ((Number(deAjustat) || 0) >= 0 ? '6814 = 491' : '491 = 7814, reluare');
const declBadge = (st, overdue) => {
  const x = DECL_ST[st] || DECL_ST.nedepusa;
  return `<span data-style="background:${x.bg};color:${x.c};border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;white-space:nowrap">${x.t}</span>`
    + (overdue ? ' <span data-u="u149">⏰ restanță</span>' : '');
};
async function loadDeclRegister(p) {
  const box = $('#declRegister'); if (!box) return;
  const data = await api('/api/declarations?period=' + p);
  if (!data.rows.length) { box.innerHTML = '<p class="muted">Nicio declarație așteptată pe această lună (profil firmă: fără TVA / fără angajați).</p>'; return; }
  const opts = (cur) => Object.keys(DECL_ST).map((k) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${DECL_ST[k].t}</option>`).join('');
  box.innerHTML = `<table><thead><tr><th>Declarație</th><th>Termen</th><th>Stare</th><th>Schimbă starea</th><th>Recipisă / detalii</th></tr></thead><tbody>${
    data.rows.map((r) => `<tr>
      <td>${H(r.nume)}</td>
      <td class="${r.overdue ? '' : 'muted'}" ${r.overdue ? 'data-u="u33"' : ''}>${r.due}</td>
      <td>${declBadge(r.status, r.overdue)}</td>
      <td><select class="decl-set" data-tip="${r.tip}" data-period="${r.period}">${opts(r.status)}</select></td>
      <td class="muted" data-u="u148">${r.recipisa ? 'recipisă: ' + r.recipisa + '<br>' : ''}${r.submittedAt ? 'depusă: ' + r.submittedAt.slice(0, 10) : (r.generatedAt ? 'XML generat: ' + r.generatedAt.slice(0, 10) : '')}${r.note ? '<br>' + r.note : ''}</td>
    </tr>`).join('')}</tbody></table>`;
  box.querySelectorAll('.decl-set').forEach((sel) => sel.addEventListener('change', async () => {
    const body = { tip: sel.dataset.tip, period: sel.dataset.period, status: sel.value };
    if (sel.value === 'depusa') body.recipisa = prompt('Număr recipisă / index depunere (opțional):') || '';
    if (sel.value === 'eroare') body.note = prompt('Descrierea erorii (opțional):') || '';
    const r = await api('/api/declarations/set', { method: 'POST', body: JSON.stringify(body) });
    toast('Stare salvată: ' + DECL_ST[sel.value].t);
    if (r.locked) toast('🔒 Perioada ' + r.locked + ' a fost blocată automat (declarație depusă) — înregistrările din lunile raportate nu se mai modifică. Deblochezi din Setări → Blocare perioadă.');
    loadDeclRegister(sel.dataset.period);
    refreshNotifBadge();
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
    kpi('✅', 'Depuse', t.depuse, t.generate + ' generate · ' + t.nedepuse + ' nedepuse', 'green',
      'Declarațiile marcate „depuse" în registrul depunerilor. „Generate" = XML descărcat dar încă nedepus.') +
    kpi('🛡️', 'Conformitate', d.conformitate + '%', t.restante + ' restanțe · ' + t.erori + ' erori', t.restante || t.erori ? 'red' : 'green',
      'Depuse împărțit la datorate (fără scutite). Restanțele = termen depășit fără depunere.');
  // bara de status (stacked) + legenda cu numarul pe fiecare stare
  const segs = [['depuse', '#0a7d33'], ['generate', '#1652d6'], ['nedepuse', '#b26a00'], ['erori', '#b00020'], ['scutite', '#8a93a3']];
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
  $('#portoFirms').innerHTML = `<table><thead><tr><th>Firma</th><th>CUI</th><th>Formă</th><th>Abonament</th><th class="num">Așteptate</th><th class="num">Depuse</th><th class="num">Generate</th><th class="num">Nedepuse</th><th class="num">Erori</th><th class="num">Atenționări</th></tr></thead><tbody>${
    d.firms.map((f) => `<tr><td>${H(f.nume)}</td><td class="muted">${H(f.cui)}</td><td>${formaBadge(f)}</td><td>${abonBadge(f.sub)}</td><td class="num">${f.counts.asteptate}</td><td class="num" data-u="u156">${f.counts.depuse}</td><td class="num">${f.counts.generate}</td><td class="num" ${f.counts.nedepuse ? 'data-u="u157"' : ''}>${f.counts.nedepuse}</td><td class="num" ${f.counts.erori ? 'data-u="u33"' : ''}>${f.counts.erori}</td><td class="num">${f.natentionari || ''}</td></tr>`).join('')}</tbody></table>`;
  $('#portoRecent').innerHTML = (d.recent || []).length
    ? `<table><thead><tr><th>Când</th><th>Firma</th><th>Cine</th><th>Acțiune</th></tr></thead><tbody>${
      d.recent.map((a) => `<tr><td class="muted">${(a.ts || '').replace('T', ' ').slice(0, 16)}</td><td>${H(a.firma)}</td><td>${H(a.username)}</td><td>${H(a.action)}${a.detail ? ' — <span class="muted">' + H(a.detail) + '</span>' : ''}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio activitate recentă.</p>';
}

// ───────────────────────── NOTIFICARI (termene fiscale) ─────────────────────────
async function refreshNotifBadge() {
  try {
    const n = await api('/api/notifications');
    const b = $('#notifBadge'); if (!b) return;
    b.textContent = n.count;
    b.classList.toggle('hidden', !n.count);
  } catch (e) { /* ignora */ }
}
async function loadNotifications() {
  const n = await api('/api/notifications');
  $('#notifList').innerHTML = n.items.length
    ? `<table><thead><tr><th></th><th>Firma</th><th>Declarația</th><th>Luna</th><th>Termen</th><th>Stare</th></tr></thead><tbody>${
      n.items.map((i) => `<tr>
        <td>${i.kind === 'restanta' ? '<span data-u="u158">⏰ RESTANȚĂ</span>' : '<span data-u="u159">📅 termen apropiat</span>'}</td>
        <td>${H(i.firma)}</td><td>${H(i.nume)}</td><td>${H(i.period)}</td>
        <td ${i.kind === 'restanta' ? 'data-u="u33"' : ''}>${i.due}</td>
        <td>${declBadge(i.status)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">✓ Nicio restanță și niciun termen în următoarele 7 zile. Totul e la zi.</p>';
  refreshNotifBadge();
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
      <h4><span class="acc">${p.cont}</span> ${H(p.den)} ${p.cui ? '<span class="muted">(' + H(p.cui) + ')</span>' : ''} <span class="pill">${lbl}</span></h4>
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
  $('#compensView').innerHTML = `<table><thead><tr><th>Partener</th><th class="num">Creanță (4111)</th><th class="num">Datorie (401)</th><th class="num">Compensabil</th><th></th></tr></thead>
    <tbody>${list.map((c) => `<tr data-cui="${H(c.cui)}"><td>${H(c.den)}${c.cui ? ' <span class="muted">(' + H(c.cui) + ')</span>' : ''}</td>
      <td class="num">${fmt(c.creanta)}</td><td class="num">${fmt(c.datorie)}</td><td class="num"><b>${fmt(c.compensabil)}</b></td>
      <td><button class="btn small primary compBtn" data-cui="${H(c.cui)}" data-max="${c.compensabil}">Compensează</button></td></tr>`).join('')}</tbody></table>`;
  $$('#compensView .compBtn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Compensezi ' + fmt(Number(b.dataset.max)) + ' lei (401 = 4111) pentru acest partener?')) return;
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
    list.length ? `<table><thead><tr><th>Partener</th><th class="num">Total</th><th class="num">0-30</th><th class="num">31-60</th><th class="num">61-90</th><th class="num">&gt;90</th>${wo ? '<th></th>' : ''}</tr></thead><tbody>${
      list.map((x) => `<tr><td>${H(x.partener)}${x.cui ? ' <span class="muted">(' + H(x.cui) + ')</span>' : ''}</td><td class="num">${fmt(x.total)}</td><td class="num">${x.b0_30 ? fmt(x.b0_30) : ''}</td><td class="num">${x.b31_60 ? fmt(x.b31_60) : ''}</td><td class="num">${x.b61_90 ? fmt(x.b61_90) : ''}</td><td class="num">${x.b90plus ? fmt(x.b90plus) : ''}</td>${wo ? `<td><button class="linkbtn woff" data-p="${encodeURIComponent(x.partener)}" data-c="${H(x.cui)}" data-s="${x.total}">scoate</button></td>` : ''}</tr>`).join('')}
      <tr class="bold"><td>TOTAL ${lbl}</td><td class="num">${fmt(t.total)}</td><td class="num">${fmt(t.b0_30)}</td><td class="num">${fmt(t.b31_60)}</td><td class="num">${fmt(t.b61_90)}</td><td class="num">${fmt(t.b90plus)}</td>${wo ? '<td></td>' : ''}</tr></tbody></table>`
      : '<p class="muted">Niciun sold restant.</p>'}</div>`;
  $('#agingView').innerHTML = tbl('De încasat (clienți)', a.clienti, a.totalClienti, 'creanțe', true) + tbl('De plătit (furnizori)', a.furnizori, a.totalFurnizori, 'datorii', false);
  $$('#agingView .woff').forEach((b) => b.addEventListener('click', async () => {
    const partener = decodeURIComponent(b.dataset.p);
    const suma = prompt('Scoatere din evidență (654 = 4111) pentru ' + partener + '. Sumă neîncasabilă:', b.dataset.s);
    if (!suma) return;
    try { const r = await api('/api/writeoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partener, cui: b.dataset.c, suma }) }); toast('Creanță scoasă: ' + fmt(r.suma) + (r.reversProvizion ? ' (+ reluare provizion ' + fmt(r.reversProvizion) + ')' : '')); loadAnalytic(); }
    catch (e) { toast(e.message, true); }
  }));
  renderProvizion();
}
async function renderProvizion() {
  const pct = $('#provPct').value || 100;
  let p; try { p = await api('/api/provizion?pct=' + pct); } catch (e) { return; }
  const det = p.detalii.length
    ? `<table><thead><tr><th>Partener</th><th class="num">Creanțe &gt;90 zile</th><th class="num">Provizion ${p.pct}%</th></tr></thead><tbody>${
      p.detalii.map((c) => `<tr><td>${H(c.partener)}${c.cui ? ' <span class="muted">(' + H(c.cui) + ')</span>' : ''}</td><td class="num">${fmt(c.vechi)}</td><td class="num">${fmt(c.provizion)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio creanță mai veche de 90 de zile.</p>';
  $('#provView').innerHTML = det + `<table data-u="u23"><tbody>
    <tr><td>Provizion necesar (${p.pct}%)</td><td class="num">${fmt(p.necesar)}</td></tr>
    <tr><td>Ajustare existentă (sold 491)</td><td class="num">${fmt(p.existent)}</td></tr>
    <tr class="bold"><td>De înregistrat (${provizionDirectie(p.deAjustat)})</td><td class="num">${fmt(Math.abs(p.deAjustat))}</td></tr></tbody></table>`;
}
$('#provPct').addEventListener('input', renderProvizion);
$('#provPost').addEventListener('click', async () => {
  try {
    const r = await api('/api/provizion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct: Number($('#provPct').value || 100) }) });
    toast(r.message || ('Ajustare înregistrată: ' + fmt(Math.abs(r.result.deAjustat))));
    loadAnalytic();
  } catch (e) { toast(e.message, true); }
});
async function loadAnalytic() {
  $('#oaCont').innerHTML = ANALYTIC_ACCOUNTS.map((c) => `<option value="${H(c)}">${H(c)} — ${H(accName(c))}</option>`).join('');
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
  toast('Sold inițial analitic salvat'); f.partener.value = ''; f.cui.value = ''; f.d.value = '0'; f.c.value = '0';
  loadAnalytic();
});


export { loadAnalytic, loadLivrabile, loadNotifications, loadPortfolio, loadReconcile, refreshNotifBadge };
// Exportate pentru testele unitare de frontend (insigna declaratiilor, sensul provizionului): test/frontend.mjs
export { declBadge, provizionDirectie };
