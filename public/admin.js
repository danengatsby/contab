'use strict';
// Administrare (tab-urile Setari + Audit, majoritatea admin): gestionarea firmelor (activare,
// creare, stergere, clona de test, import/restaurare ZIP/JSON), utilizatorii (drepturi granulare,
// invitatii, resetare parola, impersonare) si jurnalul de audit (firma / sistem). Extras din
// app.js (Etapa 4). Depinde de nucleu; init/onTab/promptFirmaSubscribe/impersonate sunt INJECTATE
// de app.js prin setAdminDeps (evita dependenta circulara admin <-> app).
import { $, $$, api, toast, USER, H, META, isDemo, confirmAction, promptAction } from './core.js';
import { stare, controaleHtml, leaga, MARIME_IMPLICITA } from './paginare.js';

let deps = {};
export function setAdminDeps(d) { deps = d; }
export const ROL_COLAB = {
  fara_acces: 'Fără acces', vizualizare: 'Doar vizualizare', operator: 'Operator', verificator: 'Verificator', aprobator: 'Aprobator',
};
const roleOptions = (selected) => Object.entries(ROL_COLAB).filter(([value]) => value !== 'fara_acces')
  .map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');

// ── Cereri de acces la o firma existenta ──
// Un contabil care preia o firma nu si-o mai creeaza a doua oara (ar iesi o firma goala, dublura),
// ci cere acces la cea reala. Decide PROPRIETARUL.
export async function renderCereriAcces() {
  const box = $('#cereriPrimite'); if (!box) return;
  let d; try { d = await api('/api/firme/cereri'); } catch (e) { box.innerHTML = ''; return; }
  const c = d.cereri || [];
  box.innerHTML = c.length
    ? `<table><thead><tr><th>Firma</th><th>Cine cere</th><th>Email</th><th>Rol Contabilitate</th><th>Când</th><th></th></tr></thead><tbody>${
      c.map((r) => `<tr><td>${H(r.firma)}</td><td>${H(r.username)}</td><td class="muted">${H(r.email)}</td>
        <td><select class="cer-rol" data-id="${H(r.id)}">${roleOptions(r.rolSolicitat || 'aprobator')}</select></td>
        <td class="muted">${String(r.ts || '').slice(0, 10)}</td>
        <td><button class="btn small primary cer-ok" data-id="${H(r.id)}">Aprobă</button>
            <button class="btn small cer-nu" data-id="${H(r.id)}">Respinge</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio cerere în așteptare.</p>';
  const decide = async (id, aprob) => {
    try {
      const role = $(`#cereriPrimite .cer-rol[data-id="${id}"]`);
      const r = await api('/api/firme/cereri/' + encodeURIComponent(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aprob, rol: role && role.value }),
      });
      toast(aprob ? ('Acces acordat în Contabilitate pentru „' + r.firma + '" ca ' + (ROL_COLAB[r.rol] || r.rol) + '.') : 'Cerere respinsă.');
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
      body: JSON.stringify({ cui: e.target.cui.value, rol: e.target.rol.value }),
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
  const autorizatie = c.autorizatieDeclarata || c.autorizatie || '';
  return `<tr>
    <td><b>${H(c.nume)}</b>${autorizatie ? ' <span class="pill warn" title="Informație declarată de utilizator; neverificată de Contabo">Autorizație declarată: ' + H(autorizatie) + ' · neverificată</span>' : ''}
      <div class="muted">${H(c.username)}${contact ? ' — ' + contact : ''}</div></td>
    <td>${c.descriere ? H(c.descriere) : '<span class="muted">—</span>'}</td>
    <td>${firme.length
    ? `<div class="srv-actiune"><select class="srv-firma" data-id="${H(c.id)}">${optiuni}</select>
         <select class="srv-rol" data-id="${H(c.id)}" aria-label="Rol acordat în Contabilitate">${roleOptions('aprobator')}</select>
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
    const role = $(`#contabiliList .srv-rol[data-id="${b.dataset.id}"]`);
    const st = $('#cerereServiciiStatus');
    const mesaj = await promptAction('Mesajul va însoți cererea de acces trimisă către ' + b.dataset.nume + '.', {
      title: 'Ceri servicii contabile', label: 'Mesaj (opțional)', multiline: true, confirmLabel: 'Trimite cererea',
    });
    if (mesaj === null) return; // Renunță
    try {
      const r = await api('/api/firme/servicii', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firmaId: Number(sel.value), contabilId: Number(b.dataset.id), rol: role.value, mesaj }),
      });
      st.className = 'status ok';
      st.textContent = 'Cerere trimisă către ' + r.contabil + ' pentru „' + r.firma + '”, cu rolul ' + (ROL_COLAB[r.rol] || r.rol) + ' în Contabilitate. Salarizarea și Trezoreria rămân închise.';
      renderContabili();
    } catch (e) { st.className = 'status err'; st.textContent = e.message; }
  }));

  // cererile trimise de mine (ca patron)
  const t = $('#serviciiTrimise');
  const tr = srv.trimise || [];
  t.innerHTML = tr.length
    ? `<table><thead><tr><th>Firma</th><th>Contabil</th><th>Rol</th><th>Stare</th><th></th></tr></thead><tbody>${
      tr.map((r) => `<tr><td>${H(r.firma)}</td><td>${H(r.contabil)}</td>
        <td>${H(ROL_COLAB[r.rol] || r.rol)}</td>
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
    ? `<table><thead><tr><th>Firma</th><th>Patron</th><th>Rol</th><th>Mesaj</th><th></th></tr></thead><tbody>${
      pr.map((r) => `<tr><td>${H(r.firma)}</td><td>${H(r.patron)}</td>
        <td><b>${H(ROL_COLAB[r.rol] || r.rol)}</b></td>
        <td class="muted">${H(r.mesaj)}</td>
        <td><button class="btn small primary srv-da" data-id="${H(r.id)}">Accept</button>
            <button class="btn small srv-nu" data-id="${H(r.id)}">Refuz</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio cerere primită.</p>';
  const decideSrv = async (id, accept) => {
    try {
      const r = await api('/api/firme/servicii/' + encodeURIComponent(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accept }),
      });
      toast(accept ? ('Ai primit acces la Contabilitate pentru „' + r.firma + '” ca ' + (ROL_COLAB[r.rol] || r.rol) + '.') : 'Cerere refuzată.');
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
        confirmFictitious: f.confirmFictitious.checked,
      }),
    });
    const cui = f.cui.value;
    f.reset(); f.tvaPlatitor.checked = true;
    st.className = 'status ok'; st.textContent = 'Firmă înscrisă (acum activă), cu o lună de probă gratuită. CUI ' + cui;
    await deps.init(); deps.onTab('setari');
  } catch (err) {
    st.className = 'status err'; st.textContent = err.message;
    if (err.status === 409) {
      const ca = $('#cerereAccesForm');
      if (ca) { ca.cui.value = f.cui.value; ca.scrollIntoView({ behavior: 'smooth', block: 'center' }); ca.cui.focus(); }
    }
  }
});
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
        ${(USER.role === 'admin' || Number(f.ownerId) === Number(USER.id)) ? ` · <button class="del fdel" data-id="${f.id}" data-nume="${H(f.nume)}">✕</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  $$('#firmeList .fact').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/firme/' + b.dataset.id + '/activate', { method: 'POST' }); await deps.init(); deps.onTab('setari'); toast('Firmă activată');
  }));
  $$('#firmeList .fsub').forEach((b) => b.addEventListener('click', () => deps.promptFirmaSubscribe(Number(b.dataset.id), b.dataset.nume)));
  $$('#firmeList .fdel').forEach((b) => b.addEventListener('click', async () => {
    const confirmName = await promptAction('Se elimină definitiv firma, toate colecțiile ei și fișierele încărcate. Tastează exact denumirea pentru confirmare: ' + b.dataset.nume, {
      title: 'Ștergi firma?', label: 'Denumirea exactă', required: true, confirmLabel: 'Șterge definitiv', danger: true,
    });
    if (confirmName == null) return;
    if (confirmName.trim() !== b.dataset.nume.trim()) return toast('Denumirea nu corespunde. Firma nu a fost ștearsă.', true);
    try { await api('/api/firme/' + b.dataset.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmName }) }); await deps.init(); deps.onTab('setari'); toast('Firmă și fișiere asociate șterse'); }
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
  if (!await confirmAction('Se creează o copie separată a firmei curente și vei fi comutat automat pe ea.', { title: 'Creezi firma de test?', confirmLabel: 'Creează copia' })) return;
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
  if (!await confirmAction('Firma „' + firmaNume + '" va fi înlocuită cu datele din „' + file.name + '".', {
    title: 'Restaurezi copia firmei?', detail: 'Datele actuale vor fi suprascrise. Serverul creează automat o plasă de siguranță înainte de restaurare.',
    confirmLabel: 'Înlocuiește datele', danger: true,
  })) return;
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
  const [users, perm] = await Promise.all([api('/api/users'), api('/api/permissions/matrix')]);
  renderFirmePersoane(users);
  const matrice = $('#permissionsMatrix');
  if (matrice) {
    const roles = perm.roles || [];
    const actions = perm.actions || [];
    matrice.innerHTML = `<table><thead><tr><th>Acțiune</th>${roles.map((r) => `<th>${H(r.role)}</th>`).join('')}</tr></thead><tbody>${
      actions.map((a) => `<tr><td>${H(a.label)}</td>${roles.map((r) => {
        const x = (r.actions || []).find((p) => p.key === a.key);
        return `<td class="num">${x && x.allowed ? '<span class="pill ok">✓</span>' : '<span class="muted">—</span>'}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table>`;
  }
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
  $$('#usersList .ulink').forEach((b) => b.addEventListener('click', async () => {
    await promptAction('Copiază și trimite acest link utilizatorului.', { title: 'Link de invitație', label: 'Link', value: b.dataset.link, confirmLabel: 'Închide' });
  }));
  $$('#usersList .uimp').forEach((b) => b.addEventListener('click', async () => {
    if (await confirmAction('Vei vedea aplicația exact ca acest utilizator. Toate acțiunile sunt jurnalizate.', { title: 'Intri pe contul utilizatorului?', confirmLabel: 'Intră pe cont' })) deps.impersonate(Number(b.dataset.id));
  }));
  $$('#usersList .udel').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmAction('Utilizatorul își va pierde accesul la aplicație.', { title: 'Ștergi utilizatorul?', confirmLabel: 'Șterge', danger: true })) return;
    try { await api('/api/users/' + b.dataset.id, { method: 'DELETE' }); renderUsers(); toast('Utilizator șters'); }
    catch (e) { toast(e.message, true); }
  }));
  $$('#usersList .ureset').forEach((b) => b.addEventListener('click', async () => {
    const np = await promptAction('Noua parolă va înlocui parola actuală a utilizatorului.', { title: 'Resetezi parola', label: 'Parolă nouă', inputType: 'password', required: true, minLength: 12, confirmLabel: 'Schimbă parola', danger: true }); if (!np) return;
    await api('/api/users/' + b.dataset.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: np }) });
    toast('Parolă resetată');
  }));
}

// Colaboratori pe firma ACTIVA (pentru ORICE utilizator, nu doar admin): contabil <-> necontabil.
const COLAB_PILL = { admin: 'background:#2f2e2a;color:#fff', contabil: 'background:#e2f5e8;color:#0a7d33', necontabil: 'background:#e7eefc;color:#1652d6', tester: 'background:#fff4e0;color:#b26a00' };
export const STARE_PREDARE = { solicitata: 'predare solicitată', pregatita: 'dosar predat', finalizata: 'finalizată', anulata: 'anulată' };
export const STARE_TRANSFER = { in_asteptare: 'așteaptă acceptarea', finalizat: 'finalizat', anulat: 'anulat', refuzat: 'refuzat' };
const lifecycleDate = (value) => value ? String(value).slice(0, 16).replace('T', ' ') : '—';

/** Markup pur, exportat si pentru testele de securitate frontend. */
export function handoffsHtml(data) {
  const rows = (data.handoffs || []).slice(-20).reverse();
  const ownerOrAdmin = !!data.poateGestiona && !data.demo;
  if (!rows.length) return '<p class="muted">Nicio încetare formală înregistrată.</p>';
  return rows.map((r) => {
    const active = r.status === 'solicitata' || r.status === 'pregatita';
    const buttons = [];
    if (r.status === 'solicitata' && Number(r.collaboratorId) === Number(data.eu)) {
      buttons.push(`<button class="btn small primary handoffready" data-id="${H(r.id)}">Confirmă predarea dosarului</button>`);
    }
    if (r.status === 'pregatita' && ownerOrAdmin) {
      buttons.push(`<button class="btn small primary handoffcomplete" data-id="${H(r.id)}" data-nume="${H(r.collaboratorName)}">Confirmă primirea și retrage accesul</button>`);
    }
    if (r.rootHash) buttons.push(`<a class="btn small" href="/api/colaboratori/handoffs/${encodeURIComponent(r.id)}/dossier">Descarcă procesul-verbal JSON</a>`);
    if (active && (ownerOrAdmin || Number(r.initiatedBy) === Number(data.eu))) {
      buttons.push(`<button class="btn small handoffcancel" data-id="${H(r.id)}">Anulează</button>`);
    }
    return `<div class="status"><b>${H(r.collaboratorName)}</b> · <span class="pill">${H(STARE_PREDARE[r.status] || r.status)}</span>
      <div class="muted">Motiv: ${H(r.reason)} · inițiat de ${H(r.initiatedByName)} la ${H(lifecycleDate(r.createdAt))}${r.rootHash ? ' · SHA-256 ' + H(String(r.rootHash).slice(0, 16)) + '…' : ''}</div>
      ${buttons.length ? `<div class="row">${buttons.join(' ')}</div>` : ''}</div>`;
  }).join('');
}

export function ownershipTransfersHtml(data) {
  const rows = (data.ownershipTransfers || []).slice(-20).reverse();
  if (!rows.length) return '<p class="muted">Niciun transfer de proprietate înregistrat.</p>';
  return rows.map((r) => {
    const buttons = [];
    if (r.status === 'in_asteptare' && Number(r.toUserId) === Number(data.eu)) {
      buttons.push(`<button class="btn small primary transferaccept" data-id="${H(r.id)}">Acceptă proprietatea</button>`);
      buttons.push(`<button class="btn small transfercancel" data-id="${H(r.id)}">Refuză</button>`);
    } else if (r.status === 'in_asteptare' && Number(r.fromUserId) === Number(data.eu)) {
      buttons.push(`<button class="btn small transfercancel" data-id="${H(r.id)}">Anulează transferul</button>`);
    }
    return `<div class="status"><b>${H(r.fromUserName)}</b> → <b>${H(r.toUserName)}</b> · <span class="pill">${H(STARE_TRANSFER[r.status] || r.status)}</span>
      <div class="muted">Inițiat la ${H(lifecycleDate(r.createdAt))}. Proprietatea nu se schimbă până la acceptare.</div>
      ${buttons.length ? `<div class="row">${buttons.join(' ')}</div>` : ''}</div>`;
  }).join('');
}

export async function renderColaboratori() {
  const box = $('#colaboratoriBox'); if (!box) return;
  box.classList.remove('hidden');
  let data;
  try { data = await api('/api/colaboratori'); } catch (e) { $('#colaboratoriList').innerHTML = `<p class="muted">${H(e.message || 'Indisponibil')}</p>`; return; }
  const cols = data.colaboratori || [];
  const demo = !!data.demo;
  const poateGestiona = !!data.poateGestiona;
  const isOwner = Number(data.ownerId) === Number(data.eu);
  const handoffTargets = new Set((data.handoffs || []).filter((r) => r.status === 'solicitata' || r.status === 'pregatita').map((r) => Number(r.collaboratorId)));
  const transferTargets = new Set((data.ownershipTransfers || []).filter((r) => r.status === 'in_asteptare').map((r) => Number(r.toUserId)));
  const pill = (c) => `<span class="pill" data-style="${COLAB_PILL[c.tip] || ''}">${c.tip || '—'}</span>`;
  const roluri = { proprietar: 'Proprietar', ...ROL_COLAB };
  const domains = ['contabilitate', 'salarizare', 'trezorerie'];
  const domainRole = (c, domain) => (c.roluri && c.roluri[domain]) || c.rol || 'vizualizare';
  const domainCell = (c, domain) => {
    if (c.rol === 'proprietar') return '<span class="pill ok">Acces complet</span>';
    const selected = domainRole(c, domain);
    if (!poateGestiona) return H(roluri[selected] || selected);
    return `<select class="coldomain" data-id="${c.id}" data-domain="${domain}" aria-label="Rol ${domain}">${
      ['fara_acces', 'vizualizare', 'operator', 'verificator', 'aprobator'].map((r) => `<option value="${r}"${selected === r ? ' selected' : ''}>${H(roluri[r])}</option>`).join('')}</select>`;
  };
  const actions = (c) => {
    if (c.rol === 'proprietar') return '';
    if (demo) return poateGestiona && c.id !== data.eu ? `<button class="del colremove" data-id="${c.id}" data-nume="${H(c.username)}">✕ scoate</button>` : '';
    if (c.pending) return poateGestiona && c.id !== data.eu ? `<button class="del colremove" data-id="${c.id}" data-nume="${H(c.username)}">✕ anulează invitația</button>` : '';
    const out = [];
    if (!handoffTargets.has(Number(c.id)) && (poateGestiona || Number(c.id) === Number(data.eu))) {
      out.push(`<button class="btn small colhandoff" data-id="${c.id}" data-nume="${H(c.username)}">Încheie colaborarea…</button>`);
    }
    if (isOwner && Number(c.id) !== Number(data.eu) && !transferTargets.has(Number(c.id))) {
      out.push(`<button class="btn small coltransfer" data-id="${c.id}" data-nume="${H(c.username)}">Transferă proprietatea…</button>`);
    }
    return out.join(' ');
  };
  $('#colaboratoriList').innerHTML = `<table><thead><tr><th>Utilizator</th><th>Tip</th><th>Contabilitate</th><th>Salarizare</th><th>Trezorerie</th><th></th></tr></thead><tbody>${
    cols.map((c) => `<tr data-col-id="${c.id}"><td><b>${H(c.username)}</b>${c.id === data.eu ? ' <span class="muted">(tu)</span>' : ''}${c.pending ? ' <span class="pill warn">invitație</span>' : ''}${c.email ? ` <span class="muted" data-u="u148">${H(c.email)}</span>` : ''}</td><td>${pill(c)}</td>
      ${domains.map((domain) => `<td>${domainCell(c, domain)}</td>`).join('')}
      <td>${actions(c)}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">Deocamdată ești singurul cu acces la această firmă.</td></tr>'}</tbody></table>`;
  const lifecycle = $('#collaborationLifecycle'); if (lifecycle) lifecycle.classList.toggle('hidden', demo);
  if ($('#handoffList')) $('#handoffList').innerHTML = demo ? '' : handoffsHtml(data);
  if ($('#ownershipTransferList')) $('#ownershipTransferList').innerHTML = demo ? '' : ownershipTransfersHtml(data);
  const form = $('#colaboratorForm');
  if (form) { form.classList.toggle('hidden', !poateGestiona); form.querySelectorAll('input,select,button').forEach((el) => { el.disabled = !poateGestiona; }); }
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
    if (!await confirmAction('Invitația pentru „' + b.dataset.nume + '" va fi anulată.', { title: 'Anulezi invitația?', confirmLabel: 'Anulează invitația', danger: true })) return;
    try { await api('/api/colaboratori/' + b.dataset.id, { method: 'DELETE' }); renderColaboratori(); toast('Colaborator scos'); }
    catch (e) { toast(e.message, true); }
  }));
  $$('#colaboratoriList .colhandoff').forEach((b) => b.addEventListener('click', async () => {
    const reason = await promptAction('Motivul va rămâne în istoricul predării. Accesul nu se retrage încă.', {
      title: 'Închei colaborarea cu ' + b.dataset.nume, label: 'Motivul încetării', required: true, minLength: 3,
      multiline: true, confirmLabel: 'Pornește predarea', danger: true,
    });
    if (reason == null) return;
    try {
      await api('/api/colaboratori/handoffs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collaboratorId: Number(b.dataset.id), reason }) });
      await renderColaboratori(); toast('Procesul formal de predare a fost pornit');
    } catch (e) { toast(e.message, true); }
  }));
  $$('#colaboratoriList .coltransfer').forEach((b) => b.addEventListener('click', async () => {
    const confirmName = await promptAction('Transferul către „' + b.dataset.nume + '" va rămâne în așteptare până când persoana acceptă. Tastează exact denumirea firmei: ' + data.firmaName, {
      title: 'Transferi proprietatea?', label: 'Denumirea exactă', required: true, confirmLabel: 'Trimite transferul', danger: true,
    });
    if (confirmName == null) return;
    try {
      await api('/api/colaboratori/ownership-transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: Number(b.dataset.id), confirmName }) });
      await renderColaboratori(); toast('Transferul așteaptă acceptarea noului proprietar');
    } catch (e) { toast(e.message, true); }
  }));
  $$('#handoffList .handoffready').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmAction('Confirmi că documentele și clarificările firmei au fost puse la dispoziția proprietarului? Aplicația va sigila acum inventarul dosarului.', { title: 'Confirmi predarea?', confirmLabel: 'Sigilează dosarul' })) return;
    try { await api('/api/colaboratori/handoffs/' + encodeURIComponent(b.dataset.id) + '/ready', { method: 'POST' }); await renderColaboratori(); toast('Dosarul a fost marcat ca predat'); }
    catch (e) { toast(e.message, true); }
  }));
  $$('#handoffList .handoffcomplete').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmAction('Confirmi primirea dosarului de la „' + b.dataset.nume + '"? După confirmare, accesul colaboratorului la firmă este retras.', { title: 'Finalizezi predarea?', confirmLabel: 'Confirmă și retrage accesul', danger: true })) return;
    try { await api('/api/colaboratori/handoffs/' + encodeURIComponent(b.dataset.id) + '/complete', { method: 'POST' }); await renderColaboratori(); toast('Predare finalizată; accesul a fost retras'); }
    catch (e) { toast(e.message, true); }
  }));
  $$('#handoffList .handoffcancel').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmAction('Accesul rămâne neschimbat, iar procesul va apărea ca anulat în istoric.', { title: 'Anulezi predarea?', confirmLabel: 'Anulează procesul' })) return;
    try { await api('/api/colaboratori/handoffs/' + encodeURIComponent(b.dataset.id) + '/cancel', { method: 'POST' }); await renderColaboratori(); toast('Procesul de predare a fost anulat'); }
    catch (e) { toast(e.message, true); }
  }));
  $$('#ownershipTransferList .transferaccept').forEach((b) => b.addEventListener('click', async () => {
    const confirmName = await promptAction('Prin acceptare devii proprietarul firmei și preiei deciziile privind accesul. Tastează exact denumirea: ' + data.firmaName, {
      title: 'Accepți proprietatea?', label: 'Denumirea exactă', required: true, confirmLabel: 'Acceptă proprietatea', danger: true,
    });
    if (confirmName == null) return;
    try {
      await api('/api/colaboratori/ownership-transfers/' + encodeURIComponent(b.dataset.id) + '/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmName }) });
      if (deps.init) await deps.init(); else await renderColaboratori();
      if (deps.onTab) deps.onTab('setari'); toast('Acum ești proprietarul firmei');
    } catch (e) { toast(e.message, true); }
  }));
  $$('#ownershipTransferList .transfercancel').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmAction('Proprietatea firmei rămâne neschimbată.', { title: 'Închizi transferul?', confirmLabel: 'Confirmă' })) return;
    try { await api('/api/colaboratori/ownership-transfers/' + encodeURIComponent(b.dataset.id) + '/cancel', { method: 'POST' }); await renderColaboratori(); toast('Transferul a fost închis'); }
    catch (e) { toast(e.message, true); }
  }));
  $$('#colaboratoriList .coldomain').forEach((s) => s.addEventListener('change', async () => {
    try {
      const row = s.closest('tr'); const roluriNoi = {};
      row.querySelectorAll('.coldomain').forEach((select) => { roluriNoi[select.dataset.domain] = select.value; });
      await api('/api/colaboratori/' + s.dataset.id + '/access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roluri: roluriNoi }) });
      toast('Accesul pe arii a fost actualizat'); renderColaboratori();
    } catch (e) { toast(e.message, true); renderColaboratori(); }
  }));
}
async function addColaborator(mod) {
  const key = ($('#colaboratorKey').value || '').trim();
  if (!key) { toast('Completează utilizatorul sau emailul.', true); return; }
  const roluri = {
    contabilitate: ($('#colaboratorRolContabilitate') && $('#colaboratorRolContabilitate').value) || 'vizualizare',
    salarizare: ($('#colaboratorRolSalarizare') && $('#colaboratorRolSalarizare').value) || 'fara_acces',
    trezorerie: ($('#colaboratorRolTrezorerie') && $('#colaboratorRolTrezorerie').value) || 'fara_acces',
  };
  const body = mod === 'invite' ? { mod: 'invite', username: key.includes('@') ? '' : key, email: key.includes('@') ? key : '', roluri } : { mod: 'existing', username: key.includes('@') ? '' : key, email: key.includes('@') ? key : '', roluri };
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
    const r = await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword: f.oldPassword.value, newPassword: f.newPassword.value }) });
    f.reset(); toast('Parolă schimbată. ' + (Number(r.sessionsRevoked) || 0) + ' sesiuni vechi au fost deconectate; dispozitivele 2FA de încredere au fost revocate.');
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
    else { await promptAction('Trimite acest link utilizatorului pentru a-și seta parola.', { title: 'Invitație creată', label: 'Link de activare', value: r.link, confirmLabel: 'Închide' }); toast('Invitație creată'); }
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
  // Panoul nu mai așteaptă furnizorul de localizare: arată ce știe și cere restul în fundal.
  // Fără mesajul ăsta, „—" la câteva rânduri ar părea o defecțiune, nu o localizare în curs.
  // Dacă furnizorul chiar e căzut, mesajul rămâne de la o reîncărcare la alta — degradarea se
  // vede, fără să pretindem că știm cauza dintr-o singură cerere.
  if (d.geoInCurs > 0) boxL.innerHTML += `<p class="muted">Se determină localizarea pentru ${Number(d.geoInCurs)} adrese noi — reîncarcă în câteva secunde ca să apară. Dacă mesajul persistă, serviciul de localizare nu răspunde; restul datelor sunt complete.</p>`;
}
$('#accessRefresh') && $('#accessRefresh').addEventListener('click', renderAccess);
$('#accessAll') && $('#accessAll').addEventListener('click', () => { ACCESS_DOAR_ESUATE = false; renderAccess(); });
$('#accessFailed') && $('#accessFailed').addEventListener('click', () => { ACCESS_DOAR_ESUATE = true; renderAccess(); });
// Filtrul de roboti lucreaza pe datele deja primite (nu cere din nou serverul): distinctia e o
// euristica pe User-Agent, deci ramane o alegere de AFISARE, nu una care sa taie date la sursa.
$('#accessVisAll') && $('#accessVisAll').addEventListener('click', () => { ACCESS_FARA_BOTI = false; renderAccess(); });
$('#accessVisOameni') && $('#accessVisOameni').addEventListener('click', () => { ACCESS_FARA_BOTI = true; renderAccess(); });

// ── Funnel comercial (admin): numai contoare agregate, separat de vizitatorii pe IP ──
export async function renderCommercialFunnel() {
  if (!USER || USER.role !== 'admin') return;
  const box = $('#funnelKpis'); const daily = $('#funnelDaily'); const status = $('#funnelStatus');
  if (!box || !daily) return;
  const range = ($('#funnelRange') && $('#funnelRange').value) || '30';
  box.innerHTML = '<p class="muted">Se încarcă…</p>'; daily.innerHTML = '';
  let data;
  try { data = await api('/api/commercial-funnel?days=' + encodeURIComponent(range)); }
  catch (e) {
    box.innerHTML = ''; daily.innerHTML = '';
    if (status) { status.className = 'status err'; status.textContent = 'Indicatorii nu au putut fi încărcați.'; }
    return;
  }
  const since = data.startedAt ? dataOra(data.startedAt) : 'prima vizită măsurată';
  if (status) {
    status.className = 'status';
    status.textContent = (data.range && data.range.label ? data.range.label : '') + ' · măsurarea a început la ' + since + '.';
  }
  box.innerHTML = (data.stages || []).map((s) => {
    const rata = s.conversionPct == null ? 'fără bază încă' : s.conversionPct.toLocaleString('ro-RO') + '% din „' + String(s.baseLabel || '') + '”';
    return `<div class="kpi blue"><div class="lbl">${H(s.label)}</div><div class="val">${Number(s.count) || 0}</div>
      <div class="sub">${H(s.base ? rata : s.description)}</div></div>`;
  }).join('') || '<p class="muted">Nicio etapă măsurată încă.</p>';

  const rows = (data.daily || []).filter((r) => Object.values(r.counts || {}).some((n) => Number(n) > 0));
  const stageIds = (data.stages || []).map((s) => s.id);
  const stageLabels = Object.fromEntries((data.stages || []).map((s) => [s.id, s.label]));
  daily.innerHTML = rows.length
    ? `<table><thead><tr><th>Zi</th>${stageIds.map((id) => '<th>' + H(stageLabels[id]) + '</th>').join('')}</tr></thead><tbody>${rows.map((r) =>
      `<tr><td>${H(String(r.day || '').split('-').reverse().join('.'))}</td>${stageIds.map((id) => '<td>' + (Number((r.counts || {})[id]) || 0) + '</td>').join('')}</tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio mișcare în intervalul ales.</p>';
  const privacy = $('#funnelPrivacy');
  if (privacy) privacy.textContent = (data.privacy && data.privacy.statement) || '';
}
$('#funnelRefresh') && $('#funnelRefresh').addEventListener('click', renderCommercialFunnel);
$('#funnelRange') && $('#funnelRange').addEventListener('change', renderCommercialFunnel);

$('#auditRefresh').addEventListener('click', renderAudit);
$('#auditScopeFirma') && $('#auditScopeFirma').addEventListener('click', () => { AUDIT_SCOPE = 'firma'; AUDIT_OFFSET = 0; renderAudit(); });
$('#auditScopeSystem') && $('#auditScopeSystem').addEventListener('click', () => { AUDIT_SCOPE = 'system'; AUDIT_OFFSET = 0; renderAudit(); });
