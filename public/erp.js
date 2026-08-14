/* ═══════════════════════════════════════════════════════════════════════════════
   ERP.JS — chrome-ul de aplicatie desktop: bara de titlu, bara de meniu, banda de
   unelte, bara de stare.

   REGULA acestui fisier: nu detine nicio stare si nu decide nimic. Tot ce face e
   sa OGLINDEASCA structura care exista deja in `#tabs` si sa reemita clicuri pe
   butoanele reale. Un element de meniu nu „stie" ce tab deschide — el cheama
   `.click()` pe butonul din `#tabs`, deci toata logica (drepturi, mod simplu,
   ascunderi din app.js) ramane intr-un singur loc. Cand app.js ascunde o intrare,
   meniul o pierde la urmatoarea resincronizare, fara ca aici sa existe o a doua
   lista care sa driftreze.

   De ce se genereaza si nu se scrie de mana: meniul aplicatiei are 9 grupuri si
   ~40 de intrari. O copie scrisa aici ar fi corecta pana la primul tab adaugat.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var LATIME_MINIMA = 901; // sub asta chrome-ul de birou nu se monteaza (vezi erp.css)

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  /* Eticheta unui buton de meniu vine ca „📥 Documente & facturi”: pictograma si
     textul se despart, fiindca in chrome-ul de birou stau in locuri diferite —
     pictograma in coloana ei, textul aliniat cu restul. Despartirea e pe prima
     secventa non-ASCII urmata de spatiu; ce nu se potriveste ramane text intreg. */
  function despartePictograma(text) {
    var t = String(text || '').trim();
    var m = t.match(/^([^\w\s(]+(?:️)?)\s+(.*)$/);
    if (m) return { ic: m[1], txt: m[2] };
    return { ic: '', txt: t };
  }

  /* Textul unui buton din `#tabs`, FARA insigna de numar (`.navbadge`): „Mesaje3”
     ar ajunge in meniu ca atare, iar numarul s-ar impietri acolo la valoarea de la
     montare. Insignele se citesc separat, in bara de stare. */
  function eticheta(btn) {
    var t = '';
    Array.prototype.forEach.call(btn.childNodes, function (n) {
      if (n.nodeType === 3) t += n.nodeValue;
      else if (n.nodeType === 1 && !n.classList.contains('navbadge')) t += n.textContent;
    });
    return t.replace(/\s+/g, ' ').trim();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  BARA DE TITLU
  // ─────────────────────────────────────────────────────────────────────────────
  function construiesteTitlu() {
    var bar = el('div', 'erp-title');
    bar.appendChild(el('span', 'et-logo', '▦'));
    bar.appendChild(el('span', 'et-app', 'CONTABO'));
    bar.appendChild(el('span', 'et-sep', '—'));
    var doc = el('span', 'et-doc', '—');
    doc.id = 'erpTitleDoc';
    bar.appendChild(doc);
    bar.appendChild(el('span', 'et-spacer'));
    var per = el('span', 'et-badge', '');
    per.id = 'erpTitlePer';
    bar.appendChild(per);
    // Butoanele de fereastra sunt DECOR: o pagina web n-are ce minimiza. Sunt scoase
    // din arborele de accesibilitate ca sa nu fie anuntate ca actiuni inexistente.
    var w = el('div', 'et-wbtns');
    w.setAttribute('aria-hidden', 'true');
    ['–', '□', '✕'].forEach(function (c) { w.appendChild(el('i', '', c)); });
    bar.appendChild(w);
    return bar;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  BARA DE MENIU — oglinda lui `#tabs`
  // ─────────────────────────────────────────────────────────────────────────────

  /* Intrarile de prim nivel (Acasa, Ghid, Mesaje, Portofoliu, Notificari) nu apartin
     niciunui grup, deci n-au unde sa se duca in bara de meniu. Se strang sub un
     prim meniu propriu — echivalentul lui „Fisier" din programele de birou. */
  var MENIU_PRIM = 'Aplicație';

  /* O intrare e „tehnic-contabila" fie prin marcajul ei, fie prin al grupului din
     care face parte (grupurile „Registre contabile", „Inchideri", „Mijloace fixe"
     sunt marcate intregi, nu buton cu buton). Modul simplu ascunde `.adv` din CSS,
     deci intrebarea nu se pune despre stilul curent, ci despre SURSA. */
  function esteAvansat(btn) {
    if (!btn || !btn.classList) return false;
    if (btn.classList.contains('adv')) return true;
    var g = btn.closest && btn.closest('.navgroup');
    return !!(g && g.classList.contains('adv'));
  }

  /* Marcajele care trebuie sa treaca de pe intrarea-sursa pe cea generata. Fara
     asta, oglinda nu mai e oglinda: `.adv` ramanea in `#tabs` si nu ajungea aici,
     deci modul simplu ascundea intrarile DOAR din bara laterala, in timp ce bara
     de meniu si banda de unelte le ofereau in continuare — desi modalul de bun
     venit si toastul de comutare promit exact contrariul („partea tehnic-contabila
     e ascunsa"). Masurat inainte de reparatie, in mod simplu: din 11 taburi `.adv`,
     0 vizibile lateral, 6 in banda de unelte, 3 grupuri intregi in bara de meniu. */
  function preiaMarcajele(sursa, generat) {
    if (esteAvansat(sursa)) generat.classList.add('adv');
    return generat;
  }

  function itemDeMeniu(btn) {
    var p = despartePictograma(eticheta(btn));
    var b = el('button', '', null);
    b.type = 'button';
    preiaMarcajele(btn, b);
    b.appendChild(el('span', 'emi', p.ic || '·'));
    b.appendChild(el('span', 'emt', p.txt));
    b.addEventListener('click', function () {
      inchideMeniuri();
      btn.click();
    });
    return b;
  }

  function construiesteMeniu() {
    var bar = el('nav', 'erp-menu');
    bar.id = 'erpMenu';
    bar.setAttribute('aria-label', 'Bara de meniu');

    var tabs = $('#tabs');
    if (!tabs) return bar;

    var grupuri = [];

    // 1) intrarile libere de la inceput
    var libere = $$('#tabs > button[data-tab]');
    if (libere.length) grupuri.push({ nume: MENIU_PRIM, ic: '▦', itemi: libere });

    // 2) grupurile declarate in DOM, in ordinea lor (= ordinea ciclului contabil)
    $$('#tabs .navgroup').forEach(function (g) {
      var lbl = g.querySelector('.navlabel');
      var itemi = Array.prototype.slice.call(g.querySelectorAll('.navmenu button[data-tab]'));
      if (!lbl || !itemi.length) return;
      var p = despartePictograma(lbl.textContent);
      grupuri.push({ nume: p.txt, ic: p.ic, itemi: itemi, sursa: g });
    });

    grupuri.forEach(function (gr) {
      var wrap = el('div', 'em-item');
      // Un grup marcat intreg dispare intreg: altfel „Registre contabile" ramanea
      // in bara de sus si se deschidea in voie peste jurnal, cartea mare, balanta.
      preiaMarcajele(gr.sursa, wrap);
      var btn = el('button', '', null);
      btn.type = 'button';
      btn.setAttribute('aria-haspopup', 'true');
      btn.setAttribute('aria-expanded', 'false');
      // Acceleratorul: prima litera a numelui, subliniata. Pur vizual — nu legam
      // Alt+litera, fiindcă ar intra in coliziune cu scurtaturile browserului.
      var nume = gr.nume;
      var u = el('u', '', nume.slice(0, 1));
      btn.appendChild(u);
      btn.appendChild(document.createTextNode(nume.slice(1)));

      var pop = el('div', 'em-pop');
      pop.setAttribute('role', 'menu');
      gr.itemi.forEach(function (it) { pop.appendChild(itemDeMeniu(it)); });

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var deschis = wrap.classList.contains('open');
        inchideMeniuri();
        if (!deschis) {
          wrap.classList.add('open');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
      // Trecerea cu mouse-ul de la un meniu deschis la vecinul lui il deschide pe
      // acela — comportamentul barelor de meniu, si singurul motiv pentru care o
      // bara de meniu e mai rapida decat un sir de butoane.
      btn.addEventListener('mouseenter', function () {
        if (!$('#erpMenu .em-item.open')) return;
        inchideMeniuri();
        wrap.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      });

      wrap.appendChild(btn);
      wrap.appendChild(pop);
      bar.appendChild(wrap);
    });

    return bar;
  }

  function inchideMeniuri() {
    $$('#erpMenu .em-item.open').forEach(function (w) {
      w.classList.remove('open');
      var b = w.querySelector('button');
      if (b) b.setAttribute('aria-expanded', 'false');
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  BANDA DE UNELTE
  // ─────────────────────────────────────────────────────────────────────────────

  /* Lista e SCURTA si curatata deliberat: o banda de unelte care are totul nu are
     nimic. Sunt operatiunile pe care un contabil le atinge in fiecare zi de lucru,
     in ordinea ciclului. Intrarile care nu exista (drepturi, mod simplu) se sar
     tacut — banda se strange, nu se rupe. */
  var UNELTE = [
    { tab: 'documente', ic: '📄', lbl: 'Document nou' },
    { tab: 'emite', ic: '🧾', lbl: 'Emite factură' },
    { tab: 'intrate', ic: '📥', lbl: 'Primite' },
    { tab: 'iesite', ic: '📤', lbl: 'Emise' },
    { sep: true },
    { tab: 'cashbook', ic: '🏦', lbl: 'Bancă & casă' },
    { tab: 'reconciliere', ic: '⚖️', lbl: 'Extras' },
    { sep: true },
    { tab: 'stocuri', ic: '📦', lbl: 'Stocuri' },
    { tab: 'salarizare', ic: '👥', lbl: 'Salarii' },
    { tab: 'mijloace', ic: '🏢', lbl: 'Mijloace fixe' },
    { sep: true },
    { tab: 'jurnal', ic: '📒', lbl: 'Jurnal' },
    { tab: 'carte', ic: '📕', lbl: 'Cartea mare' },
    { tab: 'balanta', ic: '📊', lbl: 'Balanță' },
    { sep: true },
    { tab: 'tva', ic: '💠', lbl: 'TVA' },
    { tab: 'livrabile', ic: '🏛️', lbl: 'Declarații' },
    { tab: 'inchideri', ic: '🔒', lbl: 'Închidere' },
    { sep: true },
    { tab: 'situatii', ic: '📈', lbl: 'Situații' },
    { tab: 'parteneri', ic: '👤', lbl: 'Parteneri' },
    { tab: 'plan', ic: '🗂️', lbl: 'Plan conturi' },
  ];

  function construiesteUnelte() {
    var bar = el('div', 'erp-tools');
    bar.id = 'erpTools';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Bară de unelte');

    var ultimulESep = true; // impiedica un separator la inceput sau doi la rand
    UNELTE.forEach(function (u) {
      if (u.sep) {
        if (!ultimulESep) { bar.appendChild(el('span', 'et-sep')); ultimulESep = true; }
        return;
      }
      var tinta = $('#tabs button[data-tab="' + u.tab + '"]');
      if (!tinta) return;
      var b = el('button', 'et-btn');
      b.type = 'button';
      preiaMarcajele(tinta, b);
      b.dataset.tab = u.tab;
      b.title = u.lbl;
      b.appendChild(el('span', 'eti', u.ic));
      b.appendChild(el('span', 'etl', u.lbl));
      b.addEventListener('click', function () { tinta.click(); });
      bar.appendChild(b);
      ultimulESep = false;
    });
    if (bar.lastChild && bar.lastChild.classList && bar.lastChild.classList.contains('et-sep')) {
      bar.removeChild(bar.lastChild);
    }

    // Contextul de lucru — firma si luna — MUTATE aici din bara laterala. Sunt
    // aceleasi elemente (`#firmaSelect`, `.curgroup`), nu copii: app.js le citeste
    // si le scrie in continuare, iar o copie ar fi insemnat doua adevaruri.
    var ctx = el('div', 'et-ctx');
    var fs = $('#firmaSelect');
    var cg = $('.curgroup');
    if (fs) { ctx.appendChild(el('span', 'etc-lbl', 'Firma:')); ctx.appendChild(fs); }
    if (cg) { ctx.appendChild(el('span', 'etc-lbl', 'Luna:')); ctx.appendChild(cg); }
    if (ctx.childNodes.length) bar.appendChild(ctx);

    return bar;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  BARA DE TITLU A FIECARUI ECRAN
  //
  //  38 din cele 49 de ecrane incep deja cu un `.toolbar` care contine `h2`-ul lor;
  //  11 nu. Fara un pas de uniformizare, jumatate din aplicatie ar avea bara de
  //  titlu si jumatate nu — exact felul de inconsecventa pe care un skin trebuie
  //  s-o stearga, nu s-o produca.
  //
  //  Bara injectata poarta si clasa `toolbar`, DELIBERAT: `addPanelInfo()` din
  //  app.js isi cauta titlurile cu `section .toolbar h2` si le lipeste bulele de
  //  ajutor „ⓘ". Daca titlul ar iesi din `.toolbar` — sau ar ateriza intr-un
  //  element cu alt nume — ajutorul contextual ar disparea de pe 38 de ecrane,
  //  tacut, si abia mai tarziu s-ar fi vazut ca lipseste. Cu clasa pastrata,
  //  potrivirea tine indiferent daca app.js decoreaza inainte sau dupa noi.
  // ─────────────────────────────────────────────────────────────────────────────
  function pictogramaEcranului(idTab) {
    var nav = $('#tabs button[data-tab="' + idTab + '"]');
    if (!nav) return { ic: '', txt: '' };
    return despartePictograma(eticheta(nav));
  }

  function barezaEcranele() {
    $$('.shell > main > .tab').forEach(function (tab) {
      if (tab.querySelector(':scope > .erp-win-cap')) return;
      var idTab = String(tab.id || '').replace(/^tab-/, '');
      var p = pictogramaEcranului(idTab);

      var prim = tab.firstElementChild;
      var cap;
      if (prim && prim.classList.contains('toolbar') && prim.querySelector('h2')) {
        cap = prim; // ecranul are deja bara lui — o promovam la bara de titlu
      } else {
        cap = el('div', 'toolbar');
        var h = el('h2', '', p.txt || idTab);
        cap.appendChild(h);
        tab.insertBefore(cap, tab.firstChild);
      }
      cap.classList.add('erp-win-cap');
      if (p.ic && !cap.querySelector('.ewc-ic')) {
        cap.insertBefore(el('span', 'ewc-ic', p.ic), cap.firstChild);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  BARA DE STARE
  // ─────────────────────────────────────────────────────────────────────────────
  function construiesteStare() {
    var bar = el('div', '');
    bar.id = 'erpStatus';

    var ecran = el('div', 'es-cell es-grow');
    ecran.id = 'erpStEcran';
    ecran.textContent = 'Gata';
    bar.appendChild(ecran);

    var firma = el('div', 'es-cell');
    firma.id = 'erpStFirma';
    bar.appendChild(firma);

    var per = el('div', 'es-cell');
    per.id = 'erpStPer';
    bar.appendChild(per);

    var user = el('div', 'es-cell');
    user.id = 'erpStUser';
    bar.appendChild(user);

    var conn = el('div', 'es-cell');
    conn.id = 'erpStConn';
    conn.appendChild(el('span', 'es-dot'));
    conn.appendChild(el('span', 'es-txt', 'conectat'));
    bar.appendChild(conn);

    return bar;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  SINCRONIZAREA — o singura functie, chemata de un observator si de evenimente
  // ─────────────────────────────────────────────────────────────────────────────
  function scrie(id, text) {
    var n = document.getElementById(id);
    if (n && n.textContent !== text) n.textContent = text;
  }

  function sincronizeaza() {
    var firma = $('#companyName');
    var numeFirma = firma ? firma.textContent.trim() : '';
    var per = $('#currentPeriod');
    var luna = per ? per.textContent.trim() : '';
    var user = $('#userBadge');
    var activ = $('#tabs button[data-tab].active');
    var numeEcran = activ ? despartePictograma(eticheta(activ)).txt : '';

    scrie('erpTitleDoc', numeFirma || '—');
    scrie('erpTitlePer', luna);
    scrie('erpStFirma', numeFirma || '—');
    scrie('erpStPer', luna || '—');
    scrie('erpStUser', user ? user.textContent.trim() : '');
    scrie('erpStEcran', numeEcran || 'Gata');

    // Uneltele urmeaza starea butoanelor reale: apasata cea a ecranului curent,
    // ascunse cele pe care app.js le-a ascuns (drepturi, mod simplu).
    $$('#erpTools .et-btn').forEach(function (b) {
      var t = $('#tabs button[data-tab="' + b.dataset.tab + '"]');
      var vizibil = !!t && !t.classList.contains('hidden')
        && !(t.closest('.navgroup') && t.closest('.navgroup').classList.contains('hidden'));
      b.hidden = !vizibil;
      b.classList.toggle('on', !!t && t.classList.contains('active'));
    });

    var dot = $('#erpStConn .es-dot');
    var txt = $('#erpStConn .es-txt');
    if (dot) dot.classList.toggle('off', !navigator.onLine);
    if (txt) txt.textContent = navigator.onLine ? 'conectat' : 'deconectat';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  MONTAREA
  // ─────────────────────────────────────────────────────────────────────────────
  function monteaza() {
    if (document.getElementById('erpChrome')) return;
    if (!$('#tabs') || !$('.shell')) return;

    document.body.classList.add('erp');

    var chrome = el('div', '');
    chrome.id = 'erpChrome';
    chrome.appendChild(construiesteTitlu());
    chrome.appendChild(construiesteMeniu());
    chrome.appendChild(construiesteUnelte());
    document.body.insertBefore(chrome, document.body.firstChild);
    document.body.appendChild(construiesteStare());
    barezaEcranele();

    document.addEventListener('click', inchideMeniuri);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') inchideMeniuri(); });
    window.addEventListener('online', sincronizeaza);
    window.addEventListener('offline', sincronizeaza);

    /* Un observator, nu un `setInterval`: numele firmei, luna si tab-ul activ sunt
       scrise de app.js in momente pe care nu le controlam de aici, iar o sondare
       periodica ar fi insemnat ori intarziere vizibila, ori munca degeaba de zeci
       de ori pe secunda. Se urmareste doar ce ne intereseaza. */
    var obs = new MutationObserver(sincronizeaza);
    ['#companyName', '#currentPeriod', '#userBadge', '#tabs'].forEach(function (sel) {
      var n = $(sel);
      if (n) obs.observe(n, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    });

    sincronizeaza();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  MONTAREA E NECONDITIONATA
  //
  //  A existat un comutator de aspect („🌐 Aspect modern" / „🖥️ Aspect clasic",
  //  cu alegerea tinuta in localStorage sub cheia `contab.aspect`). A fost SCOS:
  //  aspectul clasic e acum singurul, deci n-are catre ce sa comute. Cheia ramasa
  //  in browserele care apucasera sa comute e inerta — nimic n-o mai citeste, deci
  //  nu mai poate lasa pe cineva blocat in celalalt aspect.
  //
  //  Chrome-ul de birou se monteaza doar pe ecrane de birou. Sub prag, aplicatia
  //  ramane exact cum era — o banda de unelte si un arbore n-ar lasa loc cifrelor.
  // ─────────────────────────────────────────────────────────────────────────────
  function poate() { return window.innerWidth >= LATIME_MINIMA; }

  function porneste() {
    if (poate()) monteaza();
    // Rotirea unei tablete peste prag monteaza chrome-ul; sub prag il lasa montat,
    // dar ascuns din CSS — demontarea ar muta inapoi `#firmaSelect` si ar cere un
    // al doilea drum prin aceeasi logica, pentru un castig care nu se vede.
    window.addEventListener('resize', function () { if (poate()) monteaza(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', porneste);
  else porneste();
})();
