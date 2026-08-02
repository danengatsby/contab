'use strict';
// Administrare (tab-urile Setari + Audit, majoritatea admin): gestionarea firmelor (activare,
// creare, stergere, clona de test, import/restaurare ZIP/JSON), utilizatorii (drepturi granulare,
// invitatii, resetare parola, impersonare) si jurnalul de audit (firma / sistem). Extras din
// app.js (Etapa 4). Depinde de nucleu; init/onTab/promptFirmaSubscribe/impersonate sunt INJECTATE
// de app.js prin setAdminDeps (evita dependenta circulara admin <-> app).
import { $, $$, api, toast, USER, H, META, isDemo } from './core.js';
import { stare, controaleHtml, leaga, MARIME_IMPLICITA } from './paginare.js';

let deps = {};
export function setAdminDeps(d) { deps = d; }

// ── Cereri de acces la o firma existenta ──
// Un contabil care preia o firma nu si-o mai creeaza a doua oara (ar iesi o firma goala, dublura),
// ci cere acces la cea reala. Decide PROPRIETARUL.
export async function renderCereriAcces() {
  const box = $('#cereriPrimite'); if (!box) return;
  let d; try { d = await api('/api/firme/cereri'); } catch (e) { box.innerHTML = ''; return; }
  const c = d.cereri || [];
  box.innerHTML = c.length
    ? `<table><thead><tr><th>Firma</th><th>Cine cere</th><th>Email</th><th>Când</th><th></th></tr></thead><tbody>${
      c.map((r) => `<tr><td>${H(r.firma)}</td><td>${H(r.username)}</td><td class="muted">${H(r.email)}</td>
        <td class="muted">${String(r.ts || '').slice(0, 10)}</td>
        <td><button class="btn small primary cer-ok" data-id="${H(r.id)}">Aprobă</button>
            <button class="btn small cer-nu" data-id="${H(r.id)}">Respinge</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio cerere în așteptare.</p>';
  const decide = async (id, aprob) => {
    try {
      const r = await api('/api/firme/cereri/' + encodeURIComponent(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aprob }),
      });
      toast(aprob ? ('Acces acordat pentru „' + r.firma + '".') : 'Cerere respinsă.');
      renderCereriAcces();
    } catch (e) { toast(e.message, true); }
  };
  $$('#cereriPrimite .cer-ok').forEach((b2) => b2.addEventListener('click', () => decide(b2.dataset.id, true)));
  $$('#cereriPrimite .cer-nu').forEach((b2) => b2.addEventListener('click', () => decide(b2.dataset.id, false)));
}
$('#cerereAccesForm') && $('#cerereAccesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('#cerereAccesStatus');
  try {
    const r = await api('/api/firme/cerere-acces', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cui: e.target.cui.value }),
    });
    // mesajul e acelasi fie ca firma exista sau nu — ecranul nu are voie sa devina un mod de a
    // afla ce firme sunt in aplicatie, incercand CUI-uri
    st.className = 'status ok'; st.textContent = r.message;
    e.target.reset();
  } catch (err) { st.className = 'status err'; st.textContent = err.message; }
});

// ═══════════ ANGAJAREA UNUI CONTABIL: patron -> contabil (sensul invers) ═══════════
// Cererea de acces porneste de la contabil („preiau firma asta"); aici porneste de la patron
// („imi tii tu contabilitatea?"). Cine primeste cererea decide — de fiecare data celalalt.

/** Randul unui contabil din lista publica; `firme` = firmele PROPRII, pentru care poate cere servicii.
 *  Exportat separat pentru test/frontend.mjs (logica pura: construire de HTML, fara DOM). */
export function randContabil(c, firme) {
  const optiuni = firme.map((f) => `<option value="${H(f.id)}">${H(f.nume)}</option>`).join('');
  const contact = [c.oras, c.telefon].filter(Boolean).map(H).join(' · ');
  return `<tr>
    <td><b>${H(c.nume)}</b>${c.autorizatie ? ' <span class="pill" title="Număr de autorizație declarat">CECCAR ' + H(c.autorizatie) + '</span>' : ''}
      <div class="muted">${H(c.username)}${contact ? ' — ' + contact : ''}</div></td>
    <td>${c.descriere ? H(c.descriere) : '<span class="muted">—</span>'}</td>
    <td>${firme.length
    ? `<div class="srv-actiune"><select class="srv-firma" data-id="${H(c.id)}">${optiuni}</select>
         <button class="btn small primary srv-cere" data-id="${H(c.id)}" data-nume="${H(c.nume)}">Trimite cererea</button></div>`
    : '<span class="muted">Ai nevoie de o firmă proprie ca să ceri servicii.</span>'}</td></tr>`;
}

// Exportat pentru teste: eticheta romaneasca a starii unei cereri de servicii.
export const STARE_SRV = { in_asteptare: 'în așteptare', acceptata: 'acceptată', refuzata: 'refuzată', retrasa: 'retrasă' };

export async function renderContabili() {
  const box = $('#contabiliList'); if (!box) return;
  const card = $('#contabiliCard');
  let lst; let srv;
  try {
    lst = (await api('/api/firme/contabili')).contabili || [];
    srv = await api('/api/firme/servicii');
  } catch (e) {
    // contul demo primeste 403 pe lista — cardul dispare, nu ramane un tabel gol si nelamurit
    if (card) card.classList.add('hidden');
    return;
  }
  if (card) card.classList.remove('hidden');
  // firmele MELE = cele al caror proprietar sunt; doar pentru ele pot angaja pe cineva
  const firme = (META.firme || []).filter((f) => f.ownerId === USER.id);
  box.innerHTML = lst.length
    ? `<table><thead><tr><th>Contabil</th><th>Ce oferă</th><th>Pentru firma</th></tr></thead><tbody>${
      lst.map((c) => randContabil(c, firme)).join('')}</tbody></table>`
    : '<p class="muted">Deocamdată niciun contabil nu s-a declarat disponibil. Revino mai târziu — sau, dacă tu ești contabil, bifează „Apar în lista de contabili" în „Contul meu".</p>';
  $$('#contabiliList .srv-cere').forEach((b) => b.addEventListener('click', async () => {
    const sel = $(`#contabiliList .srv-firma[data-id="${b.dataset.id}"]`);
    const st = $('#cerereServiciiStatus');
    const mesaj = prompt('Un mesaj scurt pentru ' + b.dataset.nume + ' (opțional):', '');
    if (mesaj === null) return; // Renunță
    try {
      const r = await api('/api/firme/servicii', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firmaId: Number(sel.value), contabilId: Number(b.dataset.id), mesaj }),
      });
      st.className = 'status ok';
      st.textContent = 'Cerere trimisă către ' + r.contabil + ' pentru „' + r.firma + '". Primește acces doar dacă acceptă.';
      renderContabili();
    } catch (e) { st.className = 'status err'; st.textContent = e.message; }
  }));

  // cererile trimise de mine (ca patron)
  const t = $('#serviciiTrimise');
  const tr = srv.trimise || [];
  t.innerHTML = tr.length
    ? `<table><thead><tr><th>Firma</th><th>Contabil</th><th>Stare</th><th></th></tr></thead><tbody>${
      tr.map((r) => `<tr><td>${H(r.firma)}</td><td>${H(r.contabil)}</td>
        <td>${H(STARE_SRV[r.status] || r.status)}</td>
        <td>${r.status === 'in_asteptare' ? `<button class="btn small srv-retrag" data-id="${H(r.id)}">Retrage</button>` : ''}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio cerere trimisă.</p>';
  $$('#serviciiTrimise .srv-retrag').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/firme/servicii/' + encodeURIComponent(b.dataset.id) + '/retrage', { method: 'POST' }); toast('Cerere retrasă'); renderContabili(); }
    catch (e) { toast(e.message, true); }
  }));

  // cererile primite de mine (ca si contabil)
  const p2 = $('#serviciiPrimite');
  const pr = srv.primite || [];
  p2.innerHTML = pr.length
    ? `<table><thead><tr><th>Firma</th><th>Patron</th><th>Mesaj</th><th></th></tr></thead><tbody>${
      pr.map((r) => `<tr><td>${H(r.firma)}</td><td>${H(r.patron)}</td>
        <td class="muted">${H(r.mesaj)}</td>
        <td><button class="btn small primary srv-da" data-id="${H(r.id)}">Accept</button>
            <button class="btn small srv-nu" data-id="${H(r.id)}">Refuz</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio cerere primită.</p>';
  const decideSrv = async (id, accept) => {
    try {
      const r = await api('/api/firme/servicii/' + encodeURIComponent(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accept }),
      });
      toast(accept ? ('Ai primit acces la „' + r.firma + '".') : 'Cerere refuzată.');
      // acceptarea aduce o firma noua in cont: reincarca META si redeseneaza tot tabul,
      // altfel lista „Firmele mele" ramane cea de dinainte si pare ca nu s-a intamplat nimic
      if (accept) { await deps.init(); deps.onTab('setari'); return; }
      renderContabili();
    } catch (e) { toast(e.message, true); }
  };
  $$('#serviciiPrimite .srv-da').forEach((b) => b.addEventListener('click', () => decideSrv(b.dataset.id, true)));
  $$('#serviciiPrimite .srv-nu').forEach((b) => b.addEventListener('click', () => decideSrv(b.dataset.id, false)));
}


// Inscrierea unei firme PROPRII: CUI-ul primul, fiindca el decide daca firma e noua sau exista
// deja. La 409 (firma exista) nu ramane doar un mesaj rosu — se completeaza singur CUI-ul in
// formularul de cerere de acces, adica exact pasul urmator.
$('#firmaProprieForm') && $('#firmaProprieForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; const st = $('#firmaProprieStatus');
  st.className = 'status'; st.textContent = 'Se verifică CUI-ul…';
  try {
    await api('/api/firme', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nume: f.nume.value, cui: f.cui.value, regCom: f.regCom.value, oras: f.oras.value,
        tipEntitate: f.tipEntitate.value, tvaPlatitor: f.tvaPlatitor.checked,
      }),
    });
    const cui = f.cui.value;
    f.reset(); f.tvaPlatitor.checked = true;
    st.className = 'status ok'; st.textContent = 'Firmă înscrisă (acum activă), cu o lună de probă gratuită. CUI ' + cui;
    await deps.init(); deps.onTab('setari');
  } catch (err) {
    st.className = 'status err'; st.textContent = err.message;
    const cod = (err.data || {}).code;
    if (err.status === 409) {
      const ca = $('#cerereAccesForm');
      if (ca) { ca.cui.value = f.cui.value; ca.scrollIntoView({ behavior: 'smooth', block: 'center' }); ca.cui.focus(); }
    }
    // „Completeaza-ti CNP-ul" trimitea intr-un card aflat mult mai jos in aceeasi pagina, pe care
    // trebuia sa-l CAUTI. Un mesaj care numeste un loc fara sa te duca acolo e o sarcina, nu un
    // indiciu: dupa mutarea firmelor in capul paginii, „Contul meu" a ajuns al saptelea card.
    if (cod === 'CNP_LIPSA') dutaLaCnp(st);
  }
});

/** Duce utilizatorul la campul CNP din „Contul meu" si il evidentiaza cateva secunde. */
function dutaLaCnp(st) {
  const cnp = $('#profileForm') && $('#profileForm').cnp;
  if (!cnp) return;
  if (st) {
    st.innerHTML += ' <button type="button" class="linkbtn" id="mergiLaCnp">Completează CNP-ul →</button>';
    const b2 = $('#mergiLaCnp');
    if (b2) b2.addEventListener('click', () => dutaLaCnp(null));
  }
  cnp.closest('.card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  cnp.focus();
  cnp.classList.add('camp-cerut');
  setTimeout(() => cnp.classList.remove('camp-cerut'), 4000);
}
// Contabilii isi pot avea si ei propria firma (foarte des, chiar biroul lor). Formularul nu li se
// arata din start — ei vin sa preia firmele altora — dar nici nu li se inchide usa: un rand de
// text il deschide. Un cont fara nicio cale spre firma proprie ar fi fost o fundatura.
$('#firmaProprieShow') && $('#firmaProprieShow').addEventListener('click', () => {
  $('#firmaProprieBox').classList.remove('hidden');
  $('#firmaProprieLink').classList.add('hidden');
  $('#firmaProprieForm').cui.focus();
});

export async function renderFirme() {
  const data = await api('/api/firme');
  renderCereriAcces();
  renderContabili();
  // Patronul isi inscrie firme proprii — formularul e deschis de la inceput. Contabilul il are
  // dupa un rand de text; el a venit pentru firmele altora, si acelea nu se creeaza, se cer.
  const patron = USER.tipCont !== 'contabil';
  $('#firmaProprieBox') && $('#firmaProprieBox').classList.toggle('hidden', !patron);
  $('#firmaProprieLink') && $('#firmaProprieLink').classList.toggle('hidden', patron);
  // CNP-ul e conditie pentru inscriere: se spune INAINTE de a incerca, cu drum direct la camp
  const cn = $('#cnpNecesar');
  if (cn) {
    cn.classList.toggle('hidden', !!USER.cnpSetat || USER.role === 'admin');
    const g = $('#cnpNecesarGo');
    if (g && !g._wired) { g._wired = true; g.addEventListener('click', () => dutaLaCnp(null)); }
  }
  $('#firmaExport').href = '/api/firme/' + data.firmaActiva + '/export-zip';
  // Contul demo (public, partajat) nu gestioneaza firme si nici setarile contului:
  // fara Firmele mele / mediu de test / restaurare, si fara profil / parola / 2FA / conexiune SPV.
  if (isDemo()) {
    ['#firmeList', '#testCloneBtn', '#profileForm', '#pwForm', '#twofaStatus', '#anafForm'].forEach((sel) => {
      const el = $(sel); const card = el && el.closest('.card');
      if (card) card.classList.add('hidden');
    });
    $('#firmaRestoreZone') && $('#firmaRestoreZone').classList.add('hidden');
  }
  // Billing per-firma: fiecare firma are propria stare de abonament (f._sub).
  const subBadge = (f) => {
    const s = f._sub || {};
    if (s.status === 'trial') return ` <span class="pill" data-u="u10" title="Probă gratuită">🎁 probă: ${s.zileRamase} ${s.zileRamase === 1 ? 'zi' : 'zile'}</span>`;
    if (s.status === 'expired') return ' <span class="pill warn" title="Proba a expirat — abonează-te ca să continui">🎁 probă expirată</span>' + (s.pending ? ' <span class="pill" data-u="u11">⏳ plată în așteptare</span>' : '');
    if (s.status === 'none') return ' <span class="pill warn" title="Fără abonament">fără abonament</span>' + (s.pending ? ' <span class="pill" data-u="u11">⏳ plată în așteptare</span>' : '');
    if (s.status === 'active' && s.plan && s.plan !== 'grandfathered') return ` <span class="pill" data-u="u10" title="Abonament activ">✓ ${s.plan === 'pro' ? 'Pro' : s.plan === 'start' ? 'Start' : 'activ'}</span>`;
    return '';
  };
  const needsSub = (f) => f._sub && (f._sub.status === 'expired' || f._sub.status === 'none');
  $('#firmeList').innerHTML = `<table><thead><tr><th>Denumire</th><th>CUI</th><th></th></tr></thead><tbody>${
    data.firme.map((f) => `<tr>
      <td>${f.id === data.firmaActiva ? '<b>● ' + H(f.nume) + '</b>' : H(f.nume)}${subBadge(f)}</td><td>${H(f.cui)}</td>
      <td>${f.id === data.firmaActiva ? '<span class="pill">activă</span>' : `<button class="linkbtn fact" data-id="${f.id}">activează</button>`}
        ${needsSub(f) ? ` · <button class="linkbtn fsub" data-id="${f.id}" data-nume="${H(f.nume)}" data-u="u12">abonează-te →</button>` : ''}
        ${data.firme.length > 1 ? ` · <button class="del fdel" data-id="${f.id}">✕</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  $$('#firmeList .fact').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/firme/' + b.dataset.id + '/activate', { method: 'POST' }); await deps.init(); deps.onTab('setari'); toast('Firmă activată');
  }));
  $$('#firmeList .fsub').forEach((b) => b.addEventListener('click', () => deps.promptFirmaSubscribe(Number(b.dataset.id), b.dataset.nume)));
  $$('#firmeList .fdel').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi această firmă și toate datele ei?')) return;
    try { await api('/api/firme/' + b.dataset.id, { method: 'DELETE' }); await deps.init(); deps.onTab('setari'); toast('Firmă ștearsă'); }
    catch (e) { toast(e.message, true); }
  }));
  const active = data.firme.find((f) => f.id === data.firmaActiva) || {};
  const isTest = /^\[TEST\]/.test(active.nume || '') || active.test;
  const info = $('#testEnvInfo');
  if (info) info.innerHTML = isTest
    ? '🧪 <b data-u="u13">Ești pe o firmă de TEST</b> — modificările de aici NU afectează firma reală.'
    : 'Firma activă acum: <b>' + (active.nume || '—') + '</b> (reală).';
}
$('#testCloneBtn') && $('#testCloneBtn').addEventListener('click', async () => {
  const b = $('#testCloneBtn');
  if (!confirm('Creezi o copie de TEST a firmei curente și vei fi comutat pe ea. Continui?')) return;
  b.disabled = true; b.textContent = 'Se creează copia…';
  try {
    const r = await api('/api/firme/' + META.firmaActiva + '/test-clone', { method: 'POST' });
    await deps.init(); deps.onTab('setari');
    toast('Firmă de test creată: ' + r.nume + ' (acum activă)');
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; b.textContent = '🧪 Creează firmă de test (copie a celei curente)'; }
});
$('#firmaImportBtn').addEventListener('click', async () => {
  const file = $('#firmaImportFile').files[0];
  const st = $('#firmaRestoreStatus');
  const fail = (msg) => { if (st) { st.className = 'status err'; st.textContent = msg; } else toast(msg, true); };
  if (!file) return toast('Alege întâi fișierul de restaurat (ZIP sau JSON descărcat din aplicație)', true);
  const isZip = /\.zip$/i.test(file.name);
  const firmaNume = (META.firme.find((f) => f.id === META.firmaActiva) || {}).nume || 'firma activă';
  if (!confirm('⚠️ ATENȚIE: restaurarea ÎNLOCUIEȘTE toate datele firmei „' + firmaNume + '" cu cele din copia „' + file.name + '".\n\nDatele actuale ale firmei vor fi suprascrise (o plasă de siguranță se salvează automat pe server).\n\nContinui?')) return;
  if (st) { st.className = 'status'; st.textContent = 'Se restaurează…'; }
  try {
    let r;
    if (isZip) {
      const fd = new FormData(); fd.append('file', file);
      r = await api('/api/firme/import-zip?mode=replace', { method: 'POST', body: fd });
    } else {
      let bundle;
      try { bundle = JSON.parse(await file.text()); } catch (e) { return fail('Fișierul nu este un JSON valid.'); }
      if (!bundle || bundle._format !== 'contab-firma-v1' || !bundle.firma) return fail('Fișierul nu pare o copie de siguranță Contabo (format necunoscut).');
      r = await api('/api/firme/import?mode=replace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bundle) });
    }
    if (st) { st.className = 'status ok'; st.textContent = '✓ Datele firmei au fost înlocuite cu cele din copie' + (r.files != null ? ' (' + r.files + ' fișiere atașate recuperate)' : '') + '.'; }
    $('#firmaImportFile').value = '';
    toast('Copie restaurată — datele firmei au fost înlocuite');
    await deps.init(); deps.onTab('setari');
  } catch (e) { fail(e.message); }
});

// ───────────────────────── UTILIZATORI (admin) ─────────────────────────
function firmeChecks(selected) {
  const sel = new Set((selected || []).map(Number));
  return (META.firme || []).map((f) => `<label data-u="u14">
    <input type="checkbox" class="ufirma" value="${f.id}" ${sel.has(f.id) ? 'checked' : ''} data-u="u15"> ${H(f.nume)}</label>`).join('');
}
// Cine gestioneaza fiecare firma: PATRON (proprietarul, `firma.ownerId` — cel care a inscris-o si
// aproba cererile de acces) si CONTABILII (ceilalti membri, care au primit acces). Datele exista
// deja — META.firme poarta ownerId, iar /api/users poarta lista de firme a fiecarui cont — deci se
// compun in frontend, fara ruta noua.
// Exportate separat pentru test/frontend.mjs (logica pura, fara DOM).
/** Rolul unui cont PE o firma: 'patron' daca e proprietarul, 'contabil' daca doar are acces. */
export function rolPeFirma(user, firma) {
  return firma && firma.ownerId === user.id ? 'patron' : 'contabil';
}
/** Contabilii unei firme = au acces la ea, dar nu sunt proprietarul (adminul le vede pe toate, deci nu conteaza). */
export function contabiliiFirmei(users, firma) {
  return (users || []).filter((u) => u.role !== 'admin' && u.id !== firma.ownerId && (u.firme || []).includes(firma.id));
}

function renderFirmePersoane(users) {
  const box = $('#firmePersoane'); if (!box) return;
  const firme = META.firme || [];
  const numeUser = (id) => { const u = users.find((x) => x.id === id); return u ? u.username : null; };
  const rows = firme.map((f) => {
    const patron = f.ownerId ? numeUser(f.ownerId) : null;
    const contabili = contabiliiFirmei(users, f);
    return `<tr>
      <td>${patron ? '<b>' + H(patron) + '</b>' : '<span class="muted" title="Firmă fără proprietar (creată din contul de administrator) — nu primește cereri de acces">— fără patron</span>'}</td>
      <td><span class="acc">#${H(f.id)}</span> ${H(f.nume)}${f.cui ? ' <span class="muted">(' + H(f.cui) + ')</span>' : ''}</td>
      <td>${contabili.length
    ? contabili.map((u) => H(u.username) + (u.pending ? ' <span class="pill warn">invitație</span>' : '')).join(', ')
    : '<span class="muted">— niciunul</span>'}</td></tr>`;
  }).join('');
  box.innerHTML = firme.length
    ? `<table><thead><tr><th>Patron</th><th>Cod firmă</th><th>Contabil</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">Nicio firmă.</p>';
}

export async function renderUsers() {
  if (USER.role !== 'admin') return;
  const srt = $('#selfRegToggle');
  if (srt) {
    srt.checked = META.selfRegister !== false;
    srt.onchange = async () => {
      try { await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selfRegister: srt.checked }) }); META.selfRegister = srt.checked; toast(srt.checked ? 'Înscrierea publică e activată' : 'Înscrierea publică e dezactivată'); }
      catch (e) { toast(e.message, true); srt.checked = !srt.checked; }
    };
  }
  $('#userFirmeChecks').innerHTML = firmeChecks([]);
  const users = await api('/api/users');
  renderFirmePersoane(users);
  // tipul utilizatorului: admin / tester (proba) / necontabil (Start) / contabil (Pro)
  const tipPill = (u) => {
    const c = { admin: 'background:#2f2e2a;color:#fff', contabil: 'background:#e2f5e8;color:#0a7d33', necontabil: 'background:#e7eefc;color:#1652d6', tester: 'background:#fff4e0;color:#b26a00' }[u.tip] || '';
    return `<span class="pill" data-style="${c}" title="${u.plan ? 'plan: ' + u.plan : 'fără plan (probă)'}">${u.tip || '—'}</span>`;
  };
  const drCheck = (u, key, label, title) => u.role === 'admin' ? '' : `<label data-u="u16" title="${title}">
      <input type="checkbox" class="udrept" data-id="${u.id}" data-drept="${key}" data-u="u15" ${u.drepturi && u.drepturi[key] ? 'checked' : ''} /> ${label}</label>`;
  $('#usersList').innerHTML = `<table><thead><tr><th>Utilizator</th><th>Tip</th><th>Firme</th><th>Drepturi</th><th></th></tr></thead><tbody>${
    users.map((u) => `<tr><td><b>${H(u.username)}</b>${u.pending ? ' <span class="pill warn">invitație</span>' : ''}</td><td>${tipPill(u)}</td>
      <td>${u.role === 'admin' ? '<span class="muted">toate</span>' : (u.firme.map((id) => {
    const f = (META.firme || []).find((x) => x.id === id);
    const rol = rolPeFirma(u, f);
    return `<span class="acc">#${H(id)}</span> ${f ? H(f.nume) : ''} <span class="pill rol-${rol}">${rol}</span>`;
  }).join('<br>') || '<span class="muted">—</span>')}</td>
      <td>${u.role === 'admin' ? '<span class="muted">complete</span>' : drCheck(u, 'readonly', 'doar citire', 'Vede toate datele, dar nu poate modifica nimic') + '<br>' + drCheck(u, 'faraSalarii', 'fără salarii', 'Fără acces la salarizare (angajați, state de plată, fluturași, D112)')}</td>
      <td>${u.pending ? `<button class="linkbtn ulink" data-link="${u.inviteLink}">copiază link</button>` : `<button class="linkbtn ureset" data-id="${u.id}">resetează parola</button>${u.role !== 'admin' ? ` · <button class="linkbtn uimp" data-id="${u.id}">↪ intră pe cont</button>` : ''}`} · <button class="del udel" data-id="${u.id}">✕</button></td></tr>`).join('')}</tbody></table>`;
  $$('#usersList .udrept').forEach((cb) => cb.addEventListener('change', async () => {
    const row = $$('#usersList .udrept').filter((x) => x.dataset.id === cb.dataset.id);
    const drepturi = {}; row.forEach((x) => { drepturi[x.dataset.drept] = x.checked; });
    try { await api('/api/users/' + cb.dataset.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drepturi }) }); toast('Drepturi salvate'); }
    catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
  }));
  $$('#usersList .ulink').forEach((b) => b.addEventListener('click', () => prompt('Link invitație (trimite-l utilizatorului):', b.dataset.link)));
  $$('#usersList .uimp').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Intri pe contul acestui utilizator? Vei vedea aplicația exact ca el. Toate acțiunile sunt jurnalizate.')) deps.impersonate(Number(b.dataset.id));
  }));
  $$('#usersList .udel').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi utilizatorul?')) return;
    try { await api('/api/users/' + b.dataset.id, { method: 'DELETE' }); renderUsers(); toast('Utilizator șters'); }
    catch (e) { toast(e.message, true); }
  }));
  $$('#usersList .ureset').forEach((b) => b.addEventListener('click', async () => {
    const np = prompt('Parolă nouă pentru utilizator:'); if (!np) return;
    await api('/api/users/' + b.dataset.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: np }) });
    toast('Parolă resetată');
  }));
}

// Colaboratori pe firma ACTIVA (pentru ORICE utilizator, nu doar admin): contabil <-> necontabil.
const COLAB_PILL = { admin: 'background:#2f2e2a;color:#fff', contabil: 'background:#e2f5e8;color:#0a7d33', necontabil: 'background:#e7eefc;color:#1652d6', tester: 'background:#fff4e0;color:#b26a00' };
export async function renderColaboratori() {
  const box = $('#colaboratoriBox'); if (!box) return;
  box.classList.remove('hidden');
  let data;
  try { data = await api('/api/colaboratori'); } catch (e) { $('#colaboratoriList').innerHTML = `<p class="muted">${H(e.message || 'Indisponibil')}</p>`; return; }
  const cols = data.colaboratori || [];
  const demo = !!data.demo;
  const pill = (c) => `<span class="pill" data-style="${COLAB_PILL[c.tip] || ''}">${c.tip || '—'}</span>`;
  $('#colaboratoriList').innerHTML = `<table><thead><tr><th>Utilizator</th><th>Tip</th><th></th></tr></thead><tbody>${
    cols.map((c) => `<tr><td><b>${H(c.username)}</b>${c.id === data.eu ? ' <span class="muted">(tu)</span>' : ''}${c.pending ? ' <span class="pill warn">invitație</span>' : ''}${c.email ? ` <span class="muted" data-u="u148">${H(c.email)}</span>` : ''}</td><td>${pill(c)}</td>
      <td>${c.id === data.eu ? '' : `<button class="del colremove" data-id="${c.id}" data-nume="${H(c.username)}">✕ scoate</button>`}</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">Deocamdată ești singurul cu acces la această firmă.</td></tr>'}</tbody></table>`;
  const form = $('#colaboratorForm');
  if (form) form.querySelectorAll('input,button').forEach((el) => { el.disabled = false; });
  const note = $('#colaboratorInviteResult');
  const invBtn = $('#colaboratorInvite');
  if (demo) {
    // pe demo: colaborarea patron<->contabil se demonstreaza pe perechea demo/demo-contabil;
    // invitatiile de persoane noi sunt dezactivate, iar campul e pre-completat cu contul pereche
    const me = (cols.find((c) => c.id === data.eu) || {}).username || 'demo';
    const pereche = me === 'demo' ? 'demo-contabil' : 'demo';
    if (invBtn) invBtn.style.display = 'none';
    if (note) note.innerHTML = `🎭 Cont demo (<b>${H(me)}</b>): aici vezi colaborarea <b>patron↔contabil</b> pe aceeași firmă. Poți adăuga sau scoate contul pereche <b>${H(pereche)}</b>. Într-un cont propriu adaugi pe oricine (și inviți persoane noi prin link).`;
    if ($('#colaboratorKey') && !cols.some((c) => c.username === pereche)) $('#colaboratorKey').value = pereche;
  } else {
    if (invBtn) invBtn.style.display = '';
    if (note) note.innerHTML = '';
  }
  $$('#colaboratoriList .colremove').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Scoți accesul lui „' + b.dataset.nume + '" la firma activă?')) return;
    try { await api('/api/colaboratori/' + b.dataset.id, { method: 'DELETE' }); renderColaboratori(); toast('Colaborator scos'); }
    catch (e) { toast(e.message, true); }
  }));
}
async function addColaborator(mod) {
  const key = ($('#colaboratorKey').value || '').trim();
  if (!key) { toast('Completează utilizatorul sau emailul.', true); return; }
  const body = mod === 'invite' ? { mod: 'invite', username: key.includes('@') ? '' : key, email: key.includes('@') ? key : '' } : { mod: 'existing', username: key.includes('@') ? '' : key, email: key.includes('@') ? key : '' };
  if (mod === 'invite' && !body.username) { toast('Pentru invitație alege un nume de utilizator (nu email).', true); return; }
  try {
    const r = await api('/api/colaboratori', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.link) {
      $('#colaboratorInviteResult').innerHTML = `Invitație creată${r.emailed ? ' și trimisă pe email' : ''}. Link (trimite-l persoanei): <a href="${r.link}" data-u="u148">${H(r.link)}</a>`;
      toast('Invitație creată');
    } else { $('#colaboratorInviteResult').textContent = ''; toast('Colaborator adăugat'); }
    $('#colaboratorKey').value = '';
    renderColaboratori();
  } catch (e) { toast(e.message, true); }
}
$('#colaboratorAddExisting') && $('#colaboratorAddExisting').addEventListener('click', () => addColaborator('existing'));
$('#colaboratorInvite') && $('#colaboratorInvite').addEventListener('click', () => addColaborator('invite'));
$('#userNewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const firme = $$('#userFirmeChecks .ufirma').filter((c) => c.checked).map((c) => Number(c.value));
  try {
    await api('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: f.username.value, password: f.password.value, role: f.role.value, firme }) });
    f.reset(); renderUsers(); toast('Utilizator adăugat');
  } catch (err) { toast(err.message, true); }
});
$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword: f.oldPassword.value, newPassword: f.newPassword.value }) });
    f.reset(); toast('Parolă schimbată');
  } catch (err) { toast(err.message, true); }
});
$('#inviteBtn').addEventListener('click', async () => {
  const f = $('#userNewForm');
  if (!f.username.value) return toast('Completează utilizatorul', true);
  const firme = $$('#userFirmeChecks .ufirma').filter((c) => c.checked).map((c) => Number(c.value));
  try {
    const r = await api('/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: f.username.value, role: f.role.value, firme, email: f.email.value }) });
    f.reset(); renderUsers();
    if (r.emailed) toast('Invitație trimisă pe email');
    else { prompt('Trimite acest link utilizatorului (setează parola):', r.link); toast('Invitație creată'); }
  } catch (err) { toast(err.message, true); }
});

// ───────────────────────── AUDIT ─────────────────────────
let AUDIT_SCOPE = 'firma'; // 'firma' (curentă) | 'system' (global, doar admin)
// Pozitia in jurnal. Se reseteaza la schimbarea domeniului (firma/sistem): pagina 7 din jurnalul
// firmei nu inseamna nimic in cel de sistem, care are cu totul alte randuri.
let AUDIT_OFFSET = 0;
let AUDIT_LIMIT = MARIME_IMPLICITA;
export async function renderAudit() {
  const isAdmin = USER && USER.role === 'admin';
  $('#auditScope') && $('#auditScope').classList.toggle('hidden', !isAdmin);
  if (!isAdmin) AUDIT_SCOPE = 'firma';
  $('#auditScopeFirma') && $('#auditScopeFirma').classList.toggle('active', AUDIT_SCOPE === 'firma');
  $('#auditScopeSystem') && $('#auditScopeSystem').classList.toggle('active', AUDIT_SCOPE === 'system');
  // exportul CSV urmeaza scope-ul curent (firma / sistem)
  const exp = $('#auditExport'); if (exp) exp.href = AUDIT_SCOPE === 'system' ? '/csv/audit/system' : '/csv/audit';
  // Jurnalul e cea mai lungă listă din aplicație (10.770 px la 893 de rânduri, iar plafonul e
  // 20.000). Se cere de la server DOAR pagina afișată — ruta întoarce plicul { items, total, … }
  // când primește `?limit` (src/paginate.js). E singurul loc unde paginarea chiar scade și
  // memoria, și traficul, nu doar ce se vede.
  let plic;
  const q = '?limit=' + AUDIT_LIMIT + '&offset=' + AUDIT_OFFSET;
  try { plic = await api((AUDIT_SCOPE === 'system' ? '/api/audit/system' : '/api/audit') + q); } catch (e) { return; }
  const items = plic.items || [];
  const s = stare(plic.total || 0, plic.offset || 0, plic.limit || AUDIT_LIMIT);
  // Poziția se normalizează în `stare()` (o pagină golită după o ștergere ar rămâne altfel goală
  // peste date care există); dacă s-a mutat, se cere din nou de la poziția corectă.
  if (s.offset !== (plic.offset || 0) && (plic.total || 0) > 0) { AUDIT_OFFSET = s.offset; return renderAudit(); }
  AUDIT_OFFSET = s.offset;
  if (!plic.total) { $('#auditList').innerHTML = '<p class="muted">Nicio acțiune înregistrată ' + (AUDIT_SCOPE === 'system' ? 'la nivel de sistem.' : 'pentru firma curentă.') + '</p>'; return; }
  // `action` si `detail` erau interpolate NEESCAPAT. `detail` poarta date din cerere — de pilda
  // `'a ales planul ' + req.body.plan` — deci un sir cu markup ajungea in DOM-ul ADMINULUI.
  // CSP-ul (script-src 'self', fara unsafe-inline) blocheaza executia, dar asta e a doua plasa,
  // nu prima: escaparea se face aici, dupa contextul de iesire (text HTML → H).
  $('#auditList').innerHTML = `<table><thead><tr><th>Data</th><th>Utilizator</th><th>Acțiune</th><th>Detaliu</th></tr></thead><tbody>${
    items.map((a) => `<tr><td>${H((a.ts || '').replace('T', ' ').slice(0, 16))}</td><td>${H(a.username || '')}${a.viaAdmin ? ' <span class="muted">(via ' + H(a.viaAdmin) + ')</span>' : ''}</td>
      <td class="acc">${H(a.action || '')}</td><td>${H(a.detail || '')}</td></tr>`).join('')}</tbody></table>`
    + controaleHtml(s, 'audit', 'acțiuni');
  leaga('#auditList', s, (off, lim) => { AUDIT_OFFSET = off; AUDIT_LIMIT = lim; renderAudit(); });
}
// ── Cine acceseaza aplicatia (admin): sesiuni active + autentificari, cu IP si locatie ──
// Tot ce se interpoleaza aici vine, direct sau indirect, din AFARA: `username` e ales de
// utilizator, `ip` si `dispozitiv` vin din anteturi HTTP, iar `locatie` din raspunsul unui
// serviciu extern. Deci fiecare camp trece prin H() — inclusiv cele care „nu pot" contine markup.
let ACCESS_DOAR_ESUATE = false;
let ACCESS_FARA_BOTI = false;

/** „02.08.2026 09:14:22" din ISO. Pura; sirul gol ramane gol. */
function dataOra(ts) {
  const s = String(ts || '');
  if (s.length < 16) return s;
  return s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) + ' ' + s.slice(11, 19);
}

export async function renderAccess() {
  if (!USER || USER.role !== 'admin') return;
  const boxS = $('#accessSessions'); const boxL = $('#accessLogins');
  if (!boxS || !boxL) return;
  $('#accessAll') && $('#accessAll').classList.toggle('active', !ACCESS_DOAR_ESUATE);
  $('#accessFailed') && $('#accessFailed').classList.toggle('active', ACCESS_DOAR_ESUATE);
  boxS.innerHTML = '<p class="muted">Se încarcă…</p>';
  let d;
  try { d = await api('/api/access-log' + (ACCESS_DOAR_ESUATE ? '?esuate=1' : '')); }
  catch (e) { boxS.innerHTML = '<p class="status err">Nu s-a putut încărca lista de accesări.</p>'; boxL.innerHTML = ''; return; }

  const loc = (r) => (r.locatie ? H(r.locatie) : '<span class="muted">—</span>');
  const s = d.sesiuni || [];
  boxS.innerHTML = s.length
    ? `<table><thead><tr><th>Utilizator</th><th>IP</th><th>Locație</th><th>Dispozitiv</th><th>Conectat din</th><th>Ultima activitate</th></tr></thead><tbody>${
      s.map((r) => `<tr${r.online ? ' class="ok"' : ''}><td>${H(r.username || '')}${r.rol === 'admin' ? ' <span class="muted">(admin)</span>' : ''}</td>
        <td class="acc">${H(r.ip || '')}</td><td>${loc(r)}</td><td>${H(r.dispozitiv || '')}</td>
        <td>${H(dataOra(r.creata))}</td><td>${H(dataOra(r.ultimaActivitate))}${r.online ? ' <b>· acum</b>' : ''}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio sesiune activă.</p>';

  const l = d.autentificari || [];
  boxL.innerHTML = l.length
    ? `<table><thead><tr><th>Data și ora</th><th>Utilizator</th><th>IP</th><th>Locație</th><th>Rezultat</th></tr></thead><tbody>${
      l.map((r) => `<tr><td>${H(dataOra(r.ts))}</td><td>${H(r.username || '')}</td>
        <td class="acc">${H(r.ip || '')}</td><td>${loc(r)}</td>
        <td>${r.reusita ? '✓ reușită' : '✗ ' + H(r.detaliu || 'respinsă')}</td></tr>`).join('')}</tbody></table>`
    : `<p class="muted">${ACCESS_DOAR_ESUATE ? 'Nicio încercare eșuată înregistrată.' : 'Nicio autentificare înregistrată.'}</p>`;

  // Al treilea tabel: TOATE adresele care ating site-ul, nu doar cele care ajung intr-un cont.
  const boxV = $('#accessVisitors');
  if (boxV) {
    $('#accessVisAll') && $('#accessVisAll').classList.toggle('active', !ACCESS_FARA_BOTI);
    $('#accessVisOameni') && $('#accessVisOameni').classList.toggle('active', ACCESS_FARA_BOTI);
    const v = (d.vizitatori || []).filter((r) => !ACCESS_FARA_BOTI || !r.bot);
    boxV.innerHTML = v.length
      ? `<table><thead><tr><th>IP</th><th>Locație</th><th>Prima dată</th><th>Ultima dată</th><th>Pagini</th><th>Cereri</th><th>Ultima pagină</th><th>Cont</th></tr></thead><tbody>${
        v.map((r) => `<tr${r.bot ? ' class="muted"' : ''}><td class="acc">${H(r.ip || '')}${r.bot ? ' <span class="muted">(robot)</span>' : ''}</td>
          <td>${loc(r)}</td><td>${H(dataOra(r.prima))}</td><td>${H(dataOra(r.ultima))}</td>
          <td>${Number(r.pagini) || 0}</td><td>${Number(r.cereri) || 0}</td>
          <td>${H(r.ultimaCale || '')}</td>
          <td>${(r.useri || []).length ? H((r.useri || []).join(', ')) : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table>`
      : `<p class="muted">${ACCESS_FARA_BOTI ? 'Nicio accesare de la un vizitator uman încă.' : 'Nicio accesare înregistrată încă.'}</p>`;
    if ((d.vizitatoriTotal || 0) > v.length && !ACCESS_FARA_BOTI) {
      boxV.innerHTML += `<p class="muted">Se afișează ${v.length} din ${d.vizitatoriTotal} adrese.</p>`;
    }
  }

  // Onest despre ce lipseste: „—" la locatie poate insemna si „IP privat", si „serviciul tace".
  if (!d.geoDisponibil) boxL.innerHTML += '<p class="muted">Localizarea IP-urilor nu e disponibilă momentan — restul datelor sunt complete.</p>';
}
$('#accessRefresh') && $('#accessRefresh').addEventListener('click', renderAccess);
$('#accessAll') && $('#accessAll').addEventListener('click', () => { ACCESS_DOAR_ESUATE = false; renderAccess(); });
$('#accessFailed') && $('#accessFailed').addEventListener('click', () => { ACCESS_DOAR_ESUATE = true; renderAccess(); });
// Filtrul de roboti lucreaza pe datele deja primite (nu cere din nou serverul): distinctia e o
// euristica pe User-Agent, deci ramane o alegere de AFISARE, nu una care sa taie date la sursa.
$('#accessVisAll') && $('#accessVisAll').addEventListener('click', () => { ACCESS_FARA_BOTI = false; renderAccess(); });
$('#accessVisOameni') && $('#accessVisOameni').addEventListener('click', () => { ACCESS_FARA_BOTI = true; renderAccess(); });

$('#auditRefresh').addEventListener('click', renderAudit);
$('#auditScopeFirma') && $('#auditScopeFirma').addEventListener('click', () => { AUDIT_SCOPE = 'firma'; AUDIT_OFFSET = 0; renderAudit(); });
$('#auditScopeSystem') && $('#auditScopeSystem').addEventListener('click', () => { AUDIT_SCOPE = 'system'; AUDIT_OFFSET = 0; renderAudit(); });
