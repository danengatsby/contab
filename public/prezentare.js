'use strict';
// Pagina publică de prezentare: încarcă prețurile live + butonul de demo.

// Escapare locală: pagina asta e un script simplu (<script src>, nu modul), deci nu poate
// importa H din core.js. Aceeași regulă ca în restul aplicației — datele afișate se escapează
// după contextul de ieșire, chiar dacă azi vin dintr-o sursă internă (src/plans.js).
const H = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

(async function loadPlans() {
  const box = document.getElementById('plansGrid');
  if (!box) return;
  try {
    const r = await fetch('/api/plans');
    const data = await r.json();
    box.innerHTML = (data.plans || []).map((p) => `
      <div class="plan${p.recomandat ? ' reco' : ''}">
        ${p.recomandat ? '<div class="badge">Recomandat</div>' : ''}
        <h3>${H(p.nume)}</h3>
        <div class="price">${p.pret === 0 ? '<b>Gratuit</b>' : '<b>' + p.pret + '</b> ' + p.moneda + ' / ' + p.perioada}</div>
        <ul>${(p.features || []).map((f) => '<li>' + f + '</li>').join('')}</ul>
        <a class="btn ${p.trial ? 'solid' : 'buy'}" href="/?register=1">${p.trial ? 'Începe proba gratuită' : 'Alege ' + H(p.nume) + ' →'}</a>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = '<p data-u="u169">Prețurile sunt disponibile în aplicație.</p>';
  }
})();

const demoBtn = document.getElementById('demoBtn');
if (demoBtn) demoBtn.addEventListener('click', async () => {
  demoBtn.disabled = true;
  demoBtn.textContent = 'Se deschide demo…';
  try {
    const r = await fetch('/api/demo-login', { method: 'POST' });
    if (!r.ok) throw new Error('demo indisponibil');
    window.location.href = '/';
  } catch (e) {
    demoBtn.textContent = 'Demo indisponibil momentan';
    setTimeout(() => { demoBtn.disabled = false; demoBtn.textContent = 'Vezi demo cu date reale'; }, 2500);
  }
});
