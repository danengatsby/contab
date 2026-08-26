'use strict';

// Cartea de contabilitate — navigarea site-ului. Fisier EXTERN, nu <script> in pagina:
// CSP-ul aplicatiei e `script-src 'self'`, deci codul in linie e refuzat de browser.
//
// Tot textul e deja in pagina (56 de sectiuni). JS-ul doar ARATA una si le ascunde pe
// celelalte — asa cartea ramane cautabila cu Ctrl+F pe capitolul deschis, functioneaza
// offline si nu depinde de nicio cerere de retea dupa incarcare.

(function () {
  var limba = document.documentElement.getAttribute('data-carte-limba') || 'ro';
  var limbaSalvata = '';
  try { limbaSalvata = localStorage.getItem('carte-limba') || localStorage.getItem('contab_language_v1') || ''; } catch (e) { /* privat */ }
  // Prima intrare in carte urmeaza limba deja aleasa in aplicatie. Linkurile RO/EN salveaza
  // intentia inainte de navigare, deci utilizatorul poate reveni explicit la oricare versiune.
  if (limba === 'ro' && limbaSalvata === 'en' && !/\/carte\/en\//.test(location.pathname)) {
    location.replace('/carte/en/' + location.search + location.hash);
    return;
  }

  var sectiuni = Array.prototype.slice.call(document.querySelectorAll('.capitol, #coperta'));
  var linkuri = Array.prototype.slice.call(document.querySelectorAll('.nav a[data-id]'));
  var drum = document.querySelector('.drum');
  var nav = document.querySelector('.nav');
  var voal = document.querySelector('.voal');
  var cauta = document.querySelector('.cauta');
  var pasi = { prev: document.querySelector('.pasi .prec'), next: document.querySelector('.pasi .urm') };
  var ordine = linkuri.map(function (a) { return a.getAttribute('data-id'); });
  var titluCarte = (document.querySelector('.text') || {}).getAttribute
    ? document.querySelector('.text').getAttribute('data-book-title') : document.title;

  function arata(id, dinHash) {
    if (!id || ordine.indexOf(id) < 0) id = ordine[0];
    sectiuni.forEach(function (s) { s.hidden = s.id !== id; });
    linkuri.forEach(function (a) {
      var e = a.getAttribute('data-id') === id;
      a.classList.toggle('activ', e);
      if (e) { a.setAttribute('aria-current', 'page'); } else { a.removeAttribute('aria-current'); }
    });
    var activ = linkuri.filter(function (a) { return a.getAttribute('data-id') === id; })[0];
    if (drum) drum.textContent = activ ? (activ.getAttribute('data-drum') || '') : '';
    document.title = (activ ? activ.getAttribute('data-titlu') + ' · ' : '') + titluCarte;
    // pasii inainte/inapoi
    var i = ordine.indexOf(id);
    [['prev', i - 1], ['next', i + 1]].forEach(function (par) {
      var el = pasi[par[0]]; var j = par[1];
      if (!el) return;
      if (j < 0 || j >= ordine.length) { el.hidden = true; return; }
      var t = linkuri[j];
      el.hidden = false;
      el.href = '#' + ordine[j];
      el.querySelector('.tt').textContent = t.getAttribute('data-titlu');
    });
    if (!dinHash) { try { history.replaceState(null, '', '#' + id); } catch (e) { /* file:// */ } }
    // pozitia de citit: sus, si linkul activ vizibil in nav. Al doilea `scrollTo` e in cadrul
    // urmator: la deschiderea directa a unui link cu diez, browserul deruleaza NATIV la sectiune
    // DUPA ce ruleaza scriptul, deci un singur apel ar fi fost anulat imediat.
    window.scrollTo(0, 0);
    if (window.requestAnimationFrame) window.requestAnimationFrame(function () { window.scrollTo(0, 0); });
    if (activ && activ.scrollIntoView) activ.scrollIntoView({ block: 'nearest' });
    inchideNav();
  }

  function dinLocatie() { return (location.hash || '').replace(/^#/, ''); }

  // ── nav-ul ca sertar, pe ecrane inguste ──────────────────────────────────
  function deschideNav() { if (nav) nav.classList.add('deschis'); if (voal) voal.hidden = false; }
  function inchideNav() { if (nav) nav.classList.remove('deschis'); if (voal) voal.hidden = true; }
  var btnMeniu = document.querySelector('.meniu-buton');
  if (btnMeniu) btnMeniu.addEventListener('click', function () {
    if (nav.classList.contains('deschis')) inchideNav(); else deschideNav();
  });
  if (voal) voal.addEventListener('click', inchideNav);

  // ── tema ─────────────────────────────────────────────────────────────────
  var btnTema = document.querySelector('.tema-buton');
  function pune(t) {
    if (t) document.documentElement.setAttribute('data-tema', t);
    else document.documentElement.removeAttribute('data-tema');
    try { if (t) localStorage.setItem('carte-tema', t); else localStorage.removeItem('carte-tema'); } catch (e) { /* privat */ }
  }
  try { var salvat = localStorage.getItem('carte-tema'); if (salvat) pune(salvat); } catch (e) { /* privat */ }
  if (btnTema) btnTema.addEventListener('click', function () {
    var acum = document.documentElement.getAttribute('data-tema');
    if (!acum) {
      var intunecat = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      pune(intunecat ? 'light' : 'dark');
    } else { pune(acum === 'dark' ? 'light' : 'dark'); }
  });

  // ── limba ────────────────────────────────────────────────────────────────
  Array.prototype.forEach.call(document.querySelectorAll('a[data-limba]'), function (a) {
    a.addEventListener('click', function () {
      var aleasa = a.getAttribute('data-limba') || 'ro';
      try {
        localStorage.setItem('carte-limba', aleasa);
        localStorage.setItem('contab_language_v1', aleasa);
      } catch (e) { /* privat */ }
      // Pastreaza capitolul curent la schimbarea limbii, inclusiv din butonul barei mobile.
      a.href = a.href.replace(/#.*$/, '') + (location.hash || '#coperta');
    });
  });

  // ── cautare in cuprins ───────────────────────────────────────────────────
  function fara(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[șş]/gi, 's').replace(/[țţ]/gi, 't').toLowerCase();
  }
  var golCautare = document.querySelector('.gol');
  if (cauta) cauta.addEventListener('input', function () {
    var q = fara(cauta.value.trim());
    var gasite = 0;
    linkuri.forEach(function (a) {
      var ok = !q || fara(a.getAttribute('data-cauta') || a.textContent).indexOf(q) >= 0;
      a.hidden = !ok; if (ok) gasite += 1;
    });
    // titlul unei parti dispare daca niciun capitol al ei nu mai e vizibil
    Array.prototype.forEach.call(document.querySelectorAll('.grup'), function (g) {
      var vizibile = g.querySelectorAll('a[data-id]:not([hidden])').length;
      var cap = g.querySelector('.grup-cap');
      if (cap) cap.hidden = vizibile === 0;
    });
    if (golCautare) golCautare.hidden = gasite > 0;
  });

  // ── legaturi, taste, pornire ─────────────────────────────────────────────
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest ? ev.target.closest('a[href^="#"]') : null;
    if (!a) return;
    var id = a.getAttribute('href').slice(1);
    if (ordine.indexOf(id) < 0) return;
    ev.preventDefault();
    arata(id);
  });
  window.addEventListener('hashchange', function () { arata(dinLocatie(), true); });
  document.addEventListener('keydown', function (ev) {
    if (ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var i = ordine.indexOf(dinLocatie() || ordine[0]);
    if (ev.key === 'ArrowRight' && i < ordine.length - 1) { arata(ordine[i + 1]); }
    else if (ev.key === 'ArrowLeft' && i > 0) { arata(ordine[i - 1]); }
    else if (ev.key === 'Escape') { inchideNav(); }
  });

  arata(dinLocatie(), true);
}());
