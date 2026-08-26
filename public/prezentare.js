'use strict';
// Pagina publică de prezentare: încarcă prețurile live + butonul de demo.
//
// REGULA DE INSCRIERE: din afara aplicației se poate porni DOAR proba gratuită. Planurile plătite
// se afișează cu preț și funcții (omul trebuie să știe ce urmează), dar butonul lor e INACTIV:
// se aleg din aplicație, după probă. Aceeași regulă e implementată si în public/authui.js
// (ctaPlanPublic) — sunt două fișiere fiindcă acesta e script simplu, nu modul, deci nu poate
// importa. O poartă din test/run.js verifică să nu divergă.

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
    const notice = data.platiSuspendate
      ? `<div class="plan-payment-notice" role="status"><b>Plățile sunt oprite momentan.</b> ${H(data.motivPlatiSuspendate || 'Proba gratuită rămâne disponibilă și nu cere card.')}</div>`
      : '';
    box.innerHTML = notice + (data.plans || []).map((p) => `
      <div class="plan${p.recomandat ? ' reco' : ''}">
        ${p.recomandat ? '<div class="badge">Recomandat</div>' : ''}
        <h3>${H(p.nume)}</h3>
        <div class="price">${p.pret === 0 ? '<b>Gratuit</b>' : '<b>' + H(p.pret) + '</b> ' + H(p.moneda + '/' + p.perioada)}</div>
        <ul>${(p.features || []).map((f) => '<li>' + H(f) + '</li>').join('')}</ul>
        ${p.trial
          ? `<a class="btn solid" href="/?register=1">Începe proba gratuită</a>`
          : (data.platiSuspendate
            ? `<button class="btn" disabled title="Abonamentele plătite nu pot fi activate momentan.">Indisponibil momentan</button>`
            : `<button class="btn" disabled title="Începe cu proba gratuită de 30 de zile. Planul plătit îl alegi din aplicație, când proba se apropie de final.">Disponibil după probă</button>`)}
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
    setTimeout(() => { demoBtn.disabled = false; demoBtn.textContent = 'Vezi demo cu date fictive'; }, 2500);
  }
});
