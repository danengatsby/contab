'use strict';
// Pagina publică de prezentare: încarcă prețurile live + butonul de demo.

(async function loadPlans() {
  const box = document.getElementById('plansGrid');
  if (!box) return;
  try {
    const r = await fetch('/api/plans');
    const data = await r.json();
    box.innerHTML = (data.plans || []).map((p) => `
      <div class="plan${p.recomandat ? ' reco' : ''}">
        ${p.recomandat ? '<div class="badge">Recomandat</div>' : ''}
        <h3>${p.nume}</h3>
        <div class="price">${p.pret === 0 ? '<b>Gratuit</b>' : '<b>' + p.pret + '</b> ' + p.moneda + ' / ' + p.perioada}</div>
        <ul>${(p.features || []).map((f) => '<li>' + f + '</li>').join('')}</ul>
        <a class="btn ${p.trial ? 'solid' : 'buy'}" href="/?register=1">${p.trial ? 'Începe proba gratuită' : 'Alege ' + p.nume + ' →'}</a>
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
