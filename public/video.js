'use strict';
// Umple datele filmului din MANIFEST (`/descarcari/video.json`), nu din HTML scris de mana.
//
// De ce: pagina spunea „Durata 10:27" si „Zece minute" in trei locuri, hardcodate. La refacerea
// filmului (13:20) manifestul s-a actualizat singur, prin `npm run publica-video`, iar pagina a
// ramas sa anunte durata veche — deci vizitatorul citea un numar, apoi vedea altul in player.
// Manifestul e deja sursa de adevar pentru fisier, poster si amprenta; devine si pentru durata.
//
// Fisier separat, nu `<script>` inline: CSP-ul aplicatiei are `script-src 'self'` (src/bootstrap.js),
// deci un script inline ar fi fost blocat TACUT — pagina s-ar fi incarcat, doar cifra ar fi lipsit.
(async () => {
  const el = document.querySelector('#videoMeta');
  if (!el) return;
  const link = '<a href="/descarcari/contabo-prezentare.mp4" download>descarcă filmul</a>';
  try {
    const r = await fetch('/descarcari/video.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const m = await r.json();
    const bucati = [];
    if (m.durata) bucati.push('Durata ' + m.durata);
    if (m.rezolutie) bucati.push(m.rezolutie);
    if (m.octeti) bucati.push(Math.round(m.octeti / 1048576) + ' MB');
    el.innerHTML = bucati.join(' · ') + (bucati.length ? ' · ' : '') + link;
  } catch (e) {
    // Fara manifest, pagina NU inventeaza o durata: linkul de descarcare ramane, cifra lipseste.
    el.innerHTML = link;
  }
})();
