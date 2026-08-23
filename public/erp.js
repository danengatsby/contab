/* ═══════════════════════════════════════════════════════════════════════════════
   Interfața aplicației — un singur arbore de navigație și un singur context.

   Acest fișier NU creează rute, copii ale meniului sau copii ale selectoarelor.
   Arborele real `#tabs` rămâne unica navigație, iar firma și perioada sunt MUTATE
   (nu duplicate) într-o bară contextuală comună desktop/mobil. Astfel logica din
   app.js, permisiunile și modul simplu au în continuare o singură sursă de adevăr.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* Un set unic de pictograme outline. SVG-urile moștenesc culoarea textului și
     nu depind de randarea diferită a emoji-urilor între Windows, Android și iOS. */
  var ICONS = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5M9.5 20v-6h5v6"/>',
    book: '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v17H7.5A3.5 3.5 0 0 0 4 22z"/><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H13v17h3.5A3.5 3.5 0 0 1 20 22z"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
    folder: '<path d="M3 6.5h7l2 2h9V19H3z"/>',
    bell: '<path d="M6 17h12l-1.5-2V10a4.5 4.5 0 0 0-9 0v5zM10 20h4"/>',
    file: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/>',
    invoice: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h3"/>',
    bank: '<path d="m3 9 9-5 9 5zM5 10h14M6 10v7m4-7v7m4-7v7m4-7v7M3 20h18"/>',
    box: '<path d="m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10"/>',
    users: '<path d="M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM17 11a3.5 3.5 0 0 0 0-7M17 14a4 4 0 0 1 4 4v2"/>',
    building: '<path d="M4 21V5l8-3v19M12 8h8v13M7 7h2m-2 4h2m-2 4h2m6-3h2m-2 4h2M2 21h20"/>',
    ledger: '<path d="M5 3h15v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 3v18M12 8h5M12 12h5"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    tax: '<path d="M5 3h14v18H5zM8 7h8M8 11h3M14 11h2M8 15h3M14 15h2"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.7-1L14.5 3h-5l-.4 3.1a8 8 0 0 0-1.7 1L5 6.1 3 9.5 5.1 11a7 7 0 0 0 0 2L3 14.5 5 18l2.4-1.1a8 8 0 0 0 1.7 1l.4 3.1h5l.4-3.1a8 8 0 0 0 1.7-1L19 18l2-3.5-2.1-1.5a7 7 0 0 0 .1-1z"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 1 1 3.7 2c-1 .6-1.5 1.1-1.5 2.5M12 17h.01"/>',
    theme: '<path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5a8.5 8.5 0 1 0 12 12z"/>',
    density: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
    mode: '<path d="M4 5h16M7 9h10M9 13h6M11 17h2M8 21h8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    receive: '<path d="M12 3v13m0 0 5-5m-5 5-5-5M4 21h16"/>',
    send: '<path d="M12 21V8m0 0 5 5m-5-5-5 5M4 3h16"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V4h8v3M3 12h18"/>',
    warning: '<path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    offline: '<path d="M3 3l18 18M8.5 8.5A6 6 0 0 0 6 13v2a6 6 0 0 0 6 6 6 6 0 0 0 5.1-2.8M15.5 8.5A6 6 0 0 1 18 13v1M9 3v3m6-3v3"/>',
    spark: '<path d="m13 2-9 12h7l-1 8 9-12h-7z"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/>',
    calculator: '<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M8 6h8v3H8zM8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01M16 17h.01"/>',
    rocket: '<path d="M14 5c2.5-2.5 5.5-2.5 5.5-2.5S19.5 5.5 17 8l-5 5-4-4zM9 12l-4 1-2 3 5 1M12 15l-1 4-3 2-1-5M15 6l2 2"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
    download: '<path d="M12 3v12m0 0 5-5m-5 5-5-5M4 21h16"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    edit: '<path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10zM14 7l3 3M4 20h6"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8A7 7 0 0 1 18.5 7M17.9 16A7 7 0 0 1 5.5 17"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
    printer: '<path d="M7 8V3h10v5M7 17H4a2 2 0 0 1-2-2v-5h20v5a2 2 0 0 1-2 2h-3M7 14h10v7H7zM18 12h.01"/>',
    attachment: '<path d="m9 12 5.5-5.5a3 3 0 0 1 4.2 4.2l-7.8 7.8a5 5 0 0 1-7.1-7.1L12 3.2"/>',
    close: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
    flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3M7.5 16h9"/>',
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    save: '<path d="M4 3h14l2 2v16H4zM8 3v6h8V3M8 21v-7h8v7"/>',
    plug: '<path d="M9 3v6M15 3v6M7 9h10v2a5 5 0 0 1-5 5v5M8 21h8"/>',
    gift: '<rect x="3" y="9" width="18" height="12"/><path d="M12 9v12M3 13h18M7.5 9C5 9 4 7.5 4.8 6.2 6 4.3 9.5 6 12 9M16.5 9C19 9 20 7.5 19.2 6.2 18 4.3 14.5 6 12 9"/>',
    link: '<path d="m10 13 4-4M7.5 16.5l-1 1a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M16.5 7.5l1-1a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0"/>',
    arrowLeft: '<path d="M19 12H5m0 0 6-6m-6 6 6 6"/>',
    arrowRight: '<path d="M5 12h14m0 0-6-6m6 6-6 6"/>',
    generic: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>'
  };

  var TAB_ICONS = {
    dashboard: 'home', ghid: 'book', mesaje: 'chat', portofoliu: 'briefcase', notificari: 'bell',
    documente: 'plus', emite: 'invoice', intrate: 'receive', galerie: 'folder', iesite: 'send',
    'galerie-emise': 'folder', cashbook: 'bank', reconciliere: 'bank', stocuri: 'box',
    productie: 'box', configstoc: 'settings', salarizare: 'users', angajati: 'users',
    regsalarii: 'ledger', mijloace: 'building', leasing: 'building', jurnal: 'ledger',
    carte: 'book', balanta: 'chart', storno: 'ledger', inchideri: 'lock', 'inchidere-an': 'lock',
    tva: 'tax', livrabile: 'tax', saft: 'file', situatii: 'chart', parteneri: 'users',
    plan: 'ledger', setari: 'settings', cont: 'user', acces: 'users', administrare: 'settings'
  };

  var SYMBOL_ICONS = {
    '🏠': 'home', '📖': 'book', '📚': 'book', '💬': 'chat', '🗂': 'folder', '🔔': 'bell',
    '📥': 'receive', '📤': 'send', '📄': 'file', '🧾': 'invoice', '🏦': 'bank', '📦': 'box',
    '👥': 'users', '👤': 'user', '🏢': 'building', '📒': 'ledger', '📘': 'ledger', '📗': 'book',
    '🔒': 'lock', '📊': 'chart', '📈': 'chart', '⚙': 'settings', '🔎': 'search', '❓': 'help',
    '🌙': 'theme', '🎓': 'mode', '🧭': 'compass', '➕': 'plus', '☰': 'menu', '🤝': 'users',
    '📁': 'folder', '⚖': 'chart', '⏰': 'calendar', '📅': 'calendar', '🏭': 'building',
    '⚡': 'spark', '⚠': 'warning', '✓': 'check', '✔': 'check', '✅': 'check', '🌱': 'spark',
    '📋': 'file', '🛠': 'mode', '☀': 'theme', '⬇': 'download', '⬆': 'send', '🏧': 'bank',
    '💵': 'bank', '💰': 'bank', '💸': 'bank', '💳': 'bank', '🚀': 'rocket', '👁': 'eye', '🧮': 'calculator',
    '🎬': 'video', '📽': 'video', '🖼': 'folder', '🔌': 'plug', '💻': 'monitor', '🖥': 'monitor',
    '💾': 'save', '🧪': 'flask', '📎': 'attachment', '🖨': 'printer', '✎': 'edit', '✏': 'edit',
    '🔍': 'search', '🔄': 'refresh', '🔁': 'refresh', '⟳': 'refresh', '▶': 'play', '📨': 'mail',
    '📧': 'mail', '✉': 'mail', '📮': 'mail', '⧉': 'copy', '✕': 'close', '✗': 'close',
    '✘': 'close', '❌': 'close', '⛔': 'warning', '←': 'arrowLeft', '◀': 'arrowLeft',
    '↩': 'arrowLeft', '→': 'arrowRight', '↪': 'arrowRight', '↗': 'arrowRight', '↻': 'refresh',
    '🏥': 'building', '🏛': 'bank', '🛒': 'box', '📴': 'offline', 'ℹ': 'info', '⏳': 'clock',
    '🧰': 'briefcase', '🎁': 'gift', '💡': 'help', '🛡': 'lock', '🔗': 'link', '👋': 'user',
    '🎉': 'spark', '🤖': 'settings', '🗄': 'folder', '📉': 'chart', '🔮': 'spark'
  };

  function icon(name, cls) {
    var s = el('span', cls || 'app-icon');
    s.setAttribute('aria-hidden', 'true');
    s.dataset.icon = name;
    s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">'
      + (ICONS[name] || ICONS.generic) + '</svg>';
    return s;
  }

  /* Citește simbolul fără să modifice textul. Îl eliminăm abia după ce știm că
     există un SVG echivalent; astfel un semn necunoscut nu dispare din interfață. */
  function simbolInitial(nod) {
    for (var i = 0; i < nod.childNodes.length; i += 1) {
      var n = nod.childNodes[i];
      if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
      var m = n.nodeValue.match(/^\s*([^\p{L}\p{N}\s]+)\s*/u);
      if (!m) return null;
      return { nod: n, prefix: m[0], simbol: m[1].replace(/\uFE0F/g, '') };
    }
    return null;
  }

  function numeIcon(nod, simbol) {
    if (nod.dataset && nod.dataset.tab && TAB_ICONS[nod.dataset.tab]) return TAB_ICONS[nod.dataset.tab];
    if (nod.dataset && nod.dataset.go && TAB_ICONS[nod.dataset.go]) return TAB_ICONS[nod.dataset.go];
    var byId = { paletaBtn: 'search', glossaryBtn: 'help', uiModeBtn: 'mode', themeBtn: 'theme', densityBtn: 'density', tourBtn: 'compass', navToggleBtn: 'menu', logoutBtn: 'user', prevMonth: 'arrowLeft', nextMonth: 'arrowRight' };
    if (byId[nod.id]) return byId[nod.id];
    // Un simbol necunoscut rămâne text. Fallback-ul paginii se aplică numai
    // titlurilor fără simbol, nu înlocuiește aproximativ conținutul existent.
    if (simbol) return SYMBOL_ICONS[simbol] || '';
    var structural = nod.matches && nod.matches('.toolbar > h2, .card > h2, .card h3, .qa .ic, .kpi-ic, .welcome-steps .ws-ic, .explain .ei, .alert .al-ic, .notice-icon');
    if (!structural) return '';
    var tab = nod.closest && nod.closest('.tab');
    var id = tab ? String(tab.id || '').replace(/^tab-/, '') : '';
    return (id && TAB_ICONS[id]) || '';
  }

  function decoreaza(nod) {
    if (!nod) return;
    // Componentele cu pictogramă semantică proprie (alertă, acțiune rapidă, KPI)
    // nu primesc încă una derivată din destinația `data-go`. Altfel o alertă de
    // sold negativ afișa simultan pictograma „Bancă” și pictograma „Avertizare”.
    if (nod.matches && nod.matches('button, a, summary')
      && nod.querySelector(':scope > .ic, :scope > .al-ic, :scope > .kpi-ic, :scope > .ws-ic, :scope > .ei, :scope > .notice-icon')) return;
    var existent = $(':scope > .app-icon', nod);
    var info = simbolInitial(nod);
    // După prima conversie textul nu mai are simbol. Păstrăm pictograma deja aleasă,
    // în loc s-o înlocuim cu pictograma generică a paginii la fiecare MutationObserver.
    if (!info && existent) return;
    var simbol = info ? info.simbol : '';
    var nume = numeIcon(nod, simbol);
    if (!nume) return;
    if (info) info.nod.nodeValue = info.nod.nodeValue.slice(info.prefix.length);
    if (!existent || existent.dataset.icon !== nume) {
      var nou = icon(nume);
      if (existent) existent.replaceWith(nou); else nod.insertBefore(nou, nod.firstChild);
    }
    nod.dataset.uiIcon = '1';
  }

  function modernizeazaPictograme(root) {
    var selector = [
      'button', 'a', 'summary', 'label.attach-btn', '.emit-guided .gt',
      '#tabs > button[data-tab]', '#tabs .navlabel', '#tabs .navmenu button[data-tab]', '#tabs a.navlink',
      '.side-tools button', '.toolbar > h2', '.card > h2', '.card h3',
      '.qa .ic', '.kpi-ic', '.welcome-steps .ws-ic', '.explain .ei',
      '.alert .al-ic', '.notice-icon', '.offline-banner'
    ].join(',');
    $$(selector, root || document).forEach(decoreaza);
  }

  /* Explicațiile lungi devin ajutor la cerere. Elementul `.explain` rămâne în DOM
     neschimbat, deci codul care îi actualizează conținutul/ID-ul continuă să meargă. */
  function transformaAjutor(root) {
    $$('.explain:not([data-context-help])', root || document).forEach(function (box) {
      box.dataset.contextHelp = '1';
      var det = el('details', 'context-help');
      var sum = el('summary', '', 'De ce este important?');
      sum.insertBefore(icon('help', 'app-icon'), sum.firstChild);
      var body = el('div', 'context-help-body');
      box.parentNode.insertBefore(det, box);
      det.appendChild(sum);
      det.appendChild(body);
      body.appendChild(box);
    });
  }

  function construiesteContext() {
    var main = $('.shell > main');
    if (!main || $('#appContext')) return;

    var bar = el('section', 'app-context');
    bar.id = 'appContext';
    bar.setAttribute('aria-label', 'Context de lucru');

    var titlu = el('div', 'app-context-title');
    titlu.appendChild(icon('home', 'app-context-icon'));
    var titluText = el('div');
    titluText.appendChild(el('span', 'app-context-kicker', 'Spațiu de lucru'));
    var heading = el('h2', '', 'Acasă');
    heading.id = 'appContextTitle';
    titluText.appendChild(heading);
    titlu.appendChild(titluText);
    bar.appendChild(titlu);

    var controls = el('div', 'app-context-controls');
    var firma = $('#firmaSelect');
    var perioada = $('.curgroup');
    if (firma) {
      var firmaWrap = el('label', 'app-context-field');
      firmaWrap.appendChild(el('span', '', 'Firmă'));
      firmaWrap.appendChild(firma); // mutat, nu copiat
      controls.appendChild(firmaWrap);
    }
    if (perioada) {
      var perioadaWrap = el('div', 'app-context-field');
      perioadaWrap.appendChild(el('span', '', 'Perioadă'));
      perioadaWrap.appendChild(perioada); // mutat, nu copiat
      controls.appendChild(perioadaWrap);
    }
    var conexiune = el('span', 'app-online', 'Conectat');
    conexiune.id = 'appOnline';
    conexiune.setAttribute('role', 'status');
    controls.appendChild(conexiune);
    bar.appendChild(controls);

    // Un singur set de controale globale, mutat în antetul comun tuturor paginilor. Mutarea
    // păstrează listener-ele deja legate și evită două versiuni care ar putea avea stări diferite.
    var unelte = $('#sideTools');
    if (unelte) bar.appendChild(unelte);
    main.insertBefore(bar, main.firstChild);
  }

  function eticheta(btn) {
    if (!btn) return '';
    var t = '';
    Array.prototype.forEach.call(btn.childNodes, function (n) {
      if (n.nodeType === 3) t += n.nodeValue;
      else if (n.nodeType === 1 && !n.classList.contains('navbadge') && !n.classList.contains('app-icon')) t += n.textContent;
    });
    return t.replace(/\s+/g, ' ').trim();
  }

  // Tabelele de registru sunt ELE INSELE containerul de derulare: `styles.css` le da
  // `display:block; overflow-x:auto`. Cand continutul nu incape, ultima coloana pare TAIATA, nu
  // derulabila — pe balanta, la 1440px, „Sold final / credit" sta la 30px dincolo de margine si
  // nimic nu spune ca mai e ceva acolo (la 1280px sunt 190px). Marcam containerul PARINTE, care
  // nu deruleaza, ca CSS-ul sa poata pune un indiciu care ramane pe loc.
  function areDerulareOrizontala(t) {
    return t.scrollWidth - t.clientWidth > 1 && t.scrollLeft + t.clientWidth < t.scrollWidth - 1;
  }
  function marcheazaTabeleDerulabile() {
    $$('.tab table').forEach(function (t) {
      var wrap = t.parentElement && t.parentElement.classList
        && t.parentElement.classList.contains('tablewrap') ? t.parentElement : null;
      if (!wrap) return;
      var aplica = function () { wrap.classList.toggle('are-derulare', areDerulareOrizontala(t)); };
      aplica();
      // Indiciul dispare cand ai ajuns la capat, deci se recalculeaza si la derulare, o singura
      // data per tabel (`sincronizeaza` ruleaza la fiecare mutatie din DOM).
      if (!t.dataset.derulareLegata) {
        t.dataset.derulareLegata = '1';
        t.addEventListener('scroll', aplica, { passive: true });
      }
    });
  }

  function sincronizeaza() {
    var activ = $('#tabs button[data-tab].active');
    var titlu = $('#appContextTitle');
    var textTitlu = eticheta(activ) || 'Acasă';
    if (titlu && titlu.textContent !== textTitlu) titlu.textContent = textTitlu;

    var kicker = $('.app-context-kicker');
    if (kicker) {
      // Clasificarea ecranului (pas al lunii / inregistrare / consultare) se decide intr-un
      // singur loc — `marcheazaHartaLunii` din app.js, derivata din pasii inchiderii. Aici
      // doar se afiseaza ce s-a decis acolo; „Spatiu de lucru" ramane pentru restul.
      var textKicker = (activ && activ.dataset.kicker) || 'Spațiu de lucru';
      if (kicker.textContent !== textKicker) kicker.textContent = textKicker;
    }

    var icoana = $('.app-context-title .app-context-icon');
    if (icoana && activ) {
      var nume = TAB_ICONS[activ.dataset.tab] || 'generic';
      if (icoana.dataset.icon !== nume) {
        icoana.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">'
          + (ICONS[nume] || ICONS.generic) + '</svg>';
        icoana.dataset.icon = nume;
      }
    }

    marcheazaTabeleDerulabile();

    var online = $('#appOnline');
    if (online) {
      online.classList.toggle('offline', !navigator.onLine);
      var stare = navigator.onLine ? 'Conectat' : 'Fără conexiune';
      if (online.textContent !== stare) online.textContent = stare;
    }
  }

  /* Pe telefon refolosim arborele lateral real într-un sertar. Permisiunile,
     modul simplu, starea activă și ordinea ciclului rămân astfel identice cu
     desktopul; nu există o listă mobilă paralelă care să poată deriva. */
  function monteazaNavigatiaMobila() {
    var bara = $('.topbar');
    var comutator = $('#navToggleBtn');
    var fundal = $('#navBackdrop');
    var meniu = $('#tabs');
    if (!bara || !comutator || !fundal || !meniu) return;

    function inchide(restaureazaFocus) {
      var eraDeschis = bara.classList.contains('nav-open');
      bara.classList.remove('nav-open');
      document.body.classList.remove('mobile-nav-open');
      comutator.setAttribute('aria-expanded', 'false');
      if (eraDeschis && restaureazaFocus) comutator.focus();
    }

    comutator.addEventListener('click', function () {
      var deschide = !bara.classList.contains('nav-open');
      bara.classList.toggle('nav-open', deschide);
      document.body.classList.toggle('mobile-nav-open', deschide);
      comutator.setAttribute('aria-expanded', String(deschide));
      if (deschide) {
        var activ = $('button[data-tab].active', meniu) || $('button, a', meniu);
        if (activ) requestAnimationFrame(function () { activ.focus(); activ.scrollIntoView({ block: 'nearest' }); });
      }
    });
    fundal.addEventListener('click', function () { inchide(true); });
    meniu.addEventListener('click', function (ev) {
      if (ev.target.closest('button[data-tab], a.navlink')) inchide(false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && bara.classList.contains('nav-open')) inchide(true);
    });
    if (window.matchMedia) {
      var mobil = window.matchMedia('(max-width: 700px)');
      var laSchimbare = function (ev) { if (!ev.matches) inchide(false); };
      if (mobil.addEventListener) mobil.addEventListener('change', laSchimbare);
      else if (mobil.addListener) mobil.addListener(laSchimbare);
    }
  }

  function monteaza() {
    if (!$('#tabs') || !$('.shell')) return;
    document.body.classList.add('erp');
    construiesteContext();
    monteazaNavigatiaMobila();
    modernizeazaPictograme(document);
    transformaAjutor(document);

    var obs = new MutationObserver(function (mutatii) {
      var areNoduriNoi = false;
      mutatii.forEach(function (m) { if (m.addedNodes && m.addedNodes.length) areNoduriNoi = true; });
      if (areNoduriNoi) {
        modernizeazaPictograme(document);
        transformaAjutor(document);
      }
      sincronizeaza();
    });
    ['#companyName', '#currentPeriod', '#userBadge', '#tabs', '.topbar', '.shell > main'].forEach(function (sel) {
      var n = $(sel);
      if (n) obs.observe(n, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    });
    window.addEventListener('resize', marcheazaTabeleDerulabile);
    window.addEventListener('online', sincronizeaza);
    window.addEventListener('offline', sincronizeaza);
    document.addEventListener('contab:cycle-ready', sincronizeaza);
    sincronizeaza();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', monteaza);
  else monteaza();
})();
