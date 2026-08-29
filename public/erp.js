/* ═══════════════════════════════════════════════════════════════════════════════
   Interfața aplicației — o singură navigare logică și un singur context.

   Acest fișier NU creează rute, copii ale meniului sau copii ale selectoarelor.
   Navigatorul `#tabs` conține inclusiv grupul de unelte, iar firma și perioada sunt MUTATE
   (nu duplicate) într-o bară contextuală comună desktop/mobil. Logica din app.js rămâne
   sursa unică de activare a paginilor.
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
  function trad(txt) { return window.contabI18n ? window.contabI18n.t(txt) : txt; }

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
    more: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
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
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
    starFilled: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" fill="currentColor"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    arrowLeft: '<path d="M19 12H5m0 0 6-6m-6 6 6 6"/>',
    arrowRight: '<path d="M5 12h14m0 0-6-6m6 6-6 6"/>',
    generic: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>'
  };

  var TAB_ICONS = {
    dashboard: 'home', ghid: 'book', colaborare: 'users', mesaje: 'chat', portofoliu: 'briefcase', notificari: 'bell',
    documente: 'plus', emite: 'invoice', intrate: 'receive', galerie: 'folder', iesite: 'send',
    'galerie-emise': 'folder', cashbook: 'bank', reconciliere: 'bank', stocuri: 'box',
    productie: 'box', configstoc: 'settings', salarizare: 'users', angajati: 'users',
    regsalarii: 'ledger', mijloace: 'building', leasing: 'building', jurnal: 'ledger',
    carte: 'book', balanta: 'chart', storno: 'ledger', inchideri: 'lock', 'inchidere-an': 'lock',
    tva: 'tax', livrabile: 'tax', saft: 'file', situatii: 'chart', parteneri: 'users',
    plan: 'ledger', setari: 'settings', cont: 'user', acces: 'users', administrare: 'settings'
  };

  var SYMBOL_ICONS = {
    '🏠': 'home', '📖': 'book', '📚': 'book', '💬': 'chat', '🤝': 'users', '🗂': 'folder', '🔔': 'bell',
    '📥': 'receive', '📤': 'send', '📄': 'file', '🧾': 'invoice', '🏦': 'bank', '📦': 'box',
    '👥': 'users', '👤': 'user', '🏢': 'building', '📒': 'ledger', '📘': 'ledger', '📗': 'book',
    '🔒': 'lock', '📊': 'chart', '📈': 'chart', '⚙': 'settings', '🔎': 'search', '❓': 'help',
    '🌙': 'theme', '🎓': 'mode', '🧭': 'compass', '➕': 'plus', '☰': 'menu',
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
    '🎉': 'spark', '🤖': 'settings', '🗄': 'folder', '📉': 'chart', '🔮': 'spark',
    '☆': 'star', '★': 'starFilled', '⌄': 'chevronDown', '⌕': 'search', '○': 'info'
  };

  var SYMBOL_LABELS = {
    '✕': 'Închide', '✗': 'Închide', '✘': 'Închide', '❌': 'Închide',
    '✎': 'Editează', '✏': 'Editează', '⧉': 'Copiază', '🔍': 'Caută', '🔎': 'Caută',
    '☰': 'Deschide meniul', '⋮': 'Mai multe opțiuni', '⋯': 'Mai multe opțiuni'
  };

  /* Textul pictogramelor decorative nu este un nume accesibil. Îl ignorăm când verificăm dacă
     un control sau un titlu are deja text real, inclusiv pentru componentele vechi cu emoji. */
  function textFaraPictograme(nod) {
    var text = '';
    Array.prototype.forEach.call((nod && nod.childNodes) || [], function (n) {
      if (n.nodeType === 3) { text += n.nodeValue; return; }
      if (n.nodeType !== 1 || n.getAttribute('aria-hidden') === 'true') return;
      if (n.matches('.app-icon, .ic, .al-ic, .kpi-ic, .ws-ic, .ei, .notice-icon, .navbadge, .cinfo')) return;
      text += textFaraPictograme(n);
    });
    return text.replace(/\s+/g, ' ').trim();
  }

  /* După înlocuirea unui simbol cu SVG, pictograma devine intenționat `aria-hidden`. Un buton
     numai cu pictogramă ar rămâne astfel fără nume. Titlul explicit are prioritate, iar clasele
     de acțiune și simbolul inițial oferă fallback pentru controalele generate dinamic. */
  function eticheteazaControlPictograma(nod, simbol, nume) {
    if (!nod || !nod.matches || !nod.matches('button, a[href], [role="button"]')) return;
    if (nod.hasAttribute('aria-label') || nod.hasAttribute('aria-labelledby')) return;
    if (/[\p{L}\p{N}]/u.test(textFaraPictograme(nod))) return;

    var eticheta = nod.getAttribute('title') || '';
    var clase = String(nod.className || '');
    if (!eticheta && /(^|\s)(del|[^\s]*del|[^\s]*remove)(\s|$)/i.test(clase)) eticheta = 'Elimină';
    if (!eticheta && (/close|inchide/i.test(clase) || /close|inchide/i.test(nod.id || ''))) eticheta = 'Închide';
    if (!eticheta && /edit/i.test(clase)) eticheta = 'Editează';
    if (!eticheta && /copy|cop/i.test(clase)) eticheta = 'Copiază';
    if (!eticheta && /search|caut/i.test(clase)) eticheta = 'Caută';
    if (!eticheta && simbol) eticheta = SYMBOL_LABELS[simbol] || '';
    if (!eticheta && nume) {
      var dupaIcon = { close: 'Închide', edit: 'Editează', copy: 'Copiază', search: 'Caută', menu: 'Deschide meniul', more: 'Mai multe opțiuni' };
      eticheta = dupaIcon[nume] || '';
    }
    if (eticheta) nod.setAttribute('aria-label', trad(eticheta));
  }

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
    var info = simbolInitial(nod);
    // Componentele cu pictogramă semantică proprie (alertă, acțiune rapidă, KPI)
    // nu primesc încă una derivată din destinația `data-go`. Altfel o alertă de
    // sold negativ afișa simultan pictograma „Bancă” și pictograma „Avertizare”.
    if (nod.matches && nod.matches('button, a, summary')
      && nod.querySelector(':scope > .ic, :scope > .al-ic, :scope > .kpi-ic, :scope > .ws-ic, :scope > .ei, :scope > .notice-icon')) {
      eticheteazaControlPictograma(nod, info ? info.simbol : '', '');
      return;
    }
    var existent = $(':scope > .app-icon', nod);
    // După prima conversie textul nu mai are simbol. Păstrăm pictograma deja aleasă,
    // în loc s-o înlocuim cu pictograma generică a paginii la fiecare MutationObserver.
    if (!info && existent) {
      eticheteazaControlPictograma(nod, '', existent.dataset.icon || '');
      return;
    }
    var simbol = info ? info.simbol : '';
    var nume = numeIcon(nod, simbol);
    if (!nume) {
      eticheteazaControlPictograma(nod, simbol, '');
      return;
    }
    if (info) info.nod.nodeValue = info.nod.nodeValue.slice(info.prefix.length);
    if (!existent || existent.dataset.icon !== nume) {
      var nou = icon(nume);
      if (existent) existent.replaceWith(nou); else nod.insertBefore(nou, nod.firstChild);
    }
    nod.dataset.uiIcon = '1';
    eticheteazaControlPictograma(nod, simbol, nume);
  }

  function modernizeazaPictograme(root) {
    var selector = [
      'button', 'a', 'summary', 'label.attach-btn', '.emit-guided .gt',
      '#tabs > button[data-tab]', '#tabs .navlabel', '#tabs .navmenu button[data-tab]', '#tabs a.navlink',
      '#sideTools button', '#sideTools a', '.toolbar > h2', '.card > h2', '.card h3',
      '.qa .ic', '.kpi-ic', '.welcome-steps .ws-ic', '.explain .ei',
      '.alert .al-ic', '.notice-icon', '.operation-type-search-icon', '.offline-banner'
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

  function textCautare(txt) {
    return String(txt || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
  }

  /* Îmbunătățește SELECTORUL existent, fără să creeze un al doilea selector de firmă.
     Selectul nativ rămâne sursa unică (și fallback-ul tastaturii/browserului), iar butonul
     atașat deschide o căutare după denumire sau CUI pentru portofoliile multi-firmă. */
  function construiesteSelectorFirma(firma) {
    var selectorWrap = el('div', 'company-picker');
    selectorWrap.id = 'companyPicker';
    selectorWrap.appendChild(firma); // mutat, nu copiat

    var cautaBtn = el('button', 'company-picker-search-button');
    cautaBtn.id = 'companyPickerSearchButton';
    cautaBtn.type = 'button';
    cautaBtn.setAttribute('aria-haspopup', 'dialog');
    cautaBtn.setAttribute('aria-expanded', 'false');
    cautaBtn.setAttribute('aria-controls', 'companyPickerPanel');
    cautaBtn.appendChild(icon('search', 'app-icon'));
    selectorWrap.appendChild(cautaBtn);

    var panel = el('div', 'company-picker-panel hidden');
    panel.id = 'companyPickerPanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    var titluCautare = el('label', 'company-picker-search-label');
    titluCautare.htmlFor = 'companyPickerSearch';
    var input = document.createElement('input');
    input.id = 'companyPickerSearch';
    input.className = 'company-picker-search';
    input.type = 'search';
    input.autocomplete = 'off';
    input.setAttribute('aria-controls', 'companyPickerResults');
    titluCautare.appendChild(input);
    panel.appendChild(titluCautare);
    var rezultate = el('div', 'company-picker-results');
    rezultate.id = 'companyPickerResults';
    rezultate.setAttribute('role', 'listbox');
    panel.appendChild(rezultate);
    var manage = el('button', 'company-picker-manage');
    manage.type = 'button';
    panel.appendChild(manage);
    selectorWrap.appendChild(panel);

    function optiuniFirma() {
      return Array.prototype.filter.call(firma.options, function (opt) { return opt.value !== '__add__'; });
    }

    function inchide(restaureazaFocus) {
      if (panel.classList.contains('hidden')) return;
      panel.classList.add('hidden');
      cautaBtn.setAttribute('aria-expanded', 'false');
      if (restaureazaFocus) cautaBtn.focus();
    }

    function alege(opt) {
      if (!opt || String(opt.value) === String(firma.value)) { inchide(true); return; }
      firma.value = opt.value;
      inchide(false);
      firma.dispatchEvent(new Event('change', { bubbles: true }));
      firma.focus();
    }

    function randare() {
      var toate = optiuniFirma();
      var termen = textCautare(input.value);
      var filtrate = toate.filter(function (opt) {
        return !termen || textCautare([
          opt.dataset.companyName,
          opt.dataset.companyCui,
          opt.textContent
        ].join(' ')).indexOf(termen) !== -1;
      });
      rezultate.replaceChildren();
      filtrate.forEach(function (opt) {
        var rand = el('button', 'company-picker-option');
        rand.type = 'button';
        rand.setAttribute('role', 'option');
        rand.setAttribute('aria-selected', String(String(opt.value) === String(firma.value)));
        rand.dataset.value = opt.value;
        var copie = el('span', 'company-picker-option-copy');
        copie.appendChild(el('strong', '', opt.dataset.companyName || opt.textContent));
        var detalii = [];
        if (opt.dataset.companyCui) detalii.push('CUI ' + opt.dataset.companyCui);
        if (opt.dataset.companyStatus) detalii.push(opt.dataset.companyStatus);
        if (detalii.length) copie.appendChild(el('small', '', detalii.join(' · ')));
        rand.appendChild(copie);
        if (String(opt.value) === String(firma.value)) rand.appendChild(el('span', 'company-picker-check', '✓'));
        rand.addEventListener('click', function () { alege(opt); });
        rezultate.appendChild(rand);
      });
      if (!filtrate.length) rezultate.appendChild(el('p', 'company-picker-empty', trad('Nu am găsit nicio firmă.')));

      var manageOpt = Array.prototype.find.call(firma.options, function (opt) { return opt.value === '__add__'; });
      manage.classList.toggle('hidden', !manageOpt);
      manage.textContent = trad('Adaugă / gestionează firme…');
    }

    function actualizeaza() {
      var total = optiuniFirma().length;
      selectorWrap.classList.toggle('single-company', total < 2);
      cautaBtn.classList.toggle('hidden', total < 2);
      firma.title = trad('Firma activă');
      firma.setAttribute('aria-label', trad('Firma activă'));
      cautaBtn.title = trad('Caută o firmă');
      cautaBtn.setAttribute('aria-label', trad('Caută o firmă'));
      input.placeholder = trad('Caută după nume sau CUI…');
      panel.setAttribute('aria-label', trad('Caută o firmă'));
      randare();
      if (total < 2) inchide(false);
    }

    cautaBtn.addEventListener('click', function () {
      var deschide = panel.classList.contains('hidden');
      if (!deschide) { inchide(true); return; }
      panel.classList.remove('hidden');
      cautaBtn.setAttribute('aria-expanded', 'true');
      input.value = '';
      randare();
      requestAnimationFrame(function () { input.focus(); });
    });
    input.addEventListener('input', randare);
    manage.addEventListener('click', function () {
      firma.value = '__add__';
      inchide(false);
      firma.dispatchEvent(new Event('change', { bubbles: true }));
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); inchide(true); }
      if (ev.key === 'ArrowDown') {
        var primul = $('.company-picker-option', rezultate);
        if (primul) { ev.preventDefault(); primul.focus(); }
      }
      if (ev.key === 'Enter') {
        var unic = $$('.company-picker-option', rezultate);
        if (unic.length === 1) { ev.preventDefault(); unic[0].click(); }
      }
    });
    rezultate.addEventListener('keydown', function (ev) {
      var randuri = $$('.company-picker-option', rezultate);
      var index = randuri.indexOf(document.activeElement);
      if (ev.key === 'Escape') { ev.preventDefault(); inchide(true); return; }
      if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && index >= 0) {
        ev.preventDefault();
        randuri[(index + (ev.key === 'ArrowDown' ? 1 : -1) + randuri.length) % randuri.length].focus();
      }
    });
    document.addEventListener('pointerdown', function (ev) {
      if (!selectorWrap.contains(ev.target)) inchide(false);
    });
    firma.addEventListener('change', actualizeaza);
    document.addEventListener('contab:language', actualizeaza);
    new MutationObserver(actualizeaza).observe(firma, { childList: true, subtree: true });
    actualizeaza();
    return selectorWrap;
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
      var firmaWrap = el('div', 'app-context-field company-context-field');
      firmaWrap.appendChild(el('span', '', 'Firmă'));
      firmaWrap.appendChild(construiesteSelectorFirma(firma));
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

  // În mod obișnuit tabelul este containerul de derulare (`display:block; overflow-x:auto`). În
  // balanța mobilă derulează însă `.tablewrap`, ca primele coloane sticky să rămână fixe. Detectăm
  // elementul care derulează EFECTIV și îl facem focusabil numai cât există conținut ascuns.
  function areContinutOrizontalAscuns(t) {
    return !!t && t.scrollWidth - t.clientWidth > 1;
  }
  function areDerulareOrizontala(t) {
    return areContinutOrizontalAscuns(t) && t.scrollLeft + t.clientWidth < t.scrollWidth - 1;
  }

  function numeTabelDerulabil(t) {
    var caption = t.querySelector && t.querySelector('caption');
    var reper = caption || (t.closest && t.closest('.card, .tab'));
    var titlu = caption ? textFaraPictograme(caption)
      : textFaraPictograme(reper && reper.querySelector('h2, h3'));
    return trad('Tabel derulabil') + (titlu ? ': ' + titlu : '')
      + '. ' + trad('Folosește tastele săgeată pentru detalii.');
  }

  function seteazaContainerDerulabil(nod, activ, tabel) {
    if (!nod) return;
    nod.classList.toggle('scroll-focus', activ);
    if (activ) {
      if (!nod.hasAttribute('tabindex')) {
        nod.setAttribute('tabindex', '0');
        nod.dataset.scrollTabindex = '1';
      }
      if (!nod.hasAttribute('aria-label') && !nod.hasAttribute('aria-labelledby')) {
        nod.setAttribute('aria-label', numeTabelDerulabil(tabel));
        nod.dataset.scrollLabel = '1';
      }
      // Nu suprascriem semantica nativă a unui <table>; numai wrapperul primește rol de regiune.
      if (nod !== tabel && !nod.hasAttribute('role')) {
        nod.setAttribute('role', 'region');
        nod.dataset.scrollRole = '1';
      }
      return;
    }
    if (nod.dataset.scrollTabindex) { nod.removeAttribute('tabindex'); delete nod.dataset.scrollTabindex; }
    if (nod.dataset.scrollLabel) { nod.removeAttribute('aria-label'); delete nod.dataset.scrollLabel; }
    if (nod.dataset.scrollRole) { nod.removeAttribute('role'); delete nod.dataset.scrollRole; }
  }

  function marcheazaTabeleDerulabile() {
    $$('.tab table').forEach(function (t) {
      var wrap = t.closest ? t.closest('.tablewrap') : null;
      var aplica = function () {
        var container = areContinutOrizontalAscuns(wrap) ? wrap
          : (areContinutOrizontalAscuns(t) ? t : null);
        seteazaContainerDerulabil(t, container === t, t);
        seteazaContainerDerulabil(wrap, container === wrap, t);
        if (wrap) wrap.classList.toggle('are-derulare', !!container && areDerulareOrizontala(container));
      };
      aplica();
      // Indiciul dispare cand ai ajuns la capat, deci se recalculeaza si la derulare, o singura
      // data per tabel (`sincronizeaza` ruleaza la fiecare mutatie din DOM).
      [t, wrap].forEach(function (container) {
        if (!container || container.dataset.derulareLegata) return;
        container.dataset.derulareLegata = '1';
        container.addEventListener('scroll', aplica, { passive: true });
      });
    });
  }

  function sincronizeaza() {
    var activ = document.querySelector('#tabs button[data-tab].active');
    var titlu = $('#appContextTitle');
    var textTitlu = eticheta(activ) || trad('Acasă');
    if (titlu && titlu.textContent !== textTitlu) titlu.textContent = textTitlu;

    var kicker = $('.app-context-kicker');
    if (kicker) {
      // Clasificarea ecranului (pas al lunii / inregistrare / consultare) se decide intr-un
      // singur loc — `marcheazaHartaLunii` din app.js, derivata din pasii inchiderii. Aici
      // doar se afiseaza ce s-a decis acolo; „Spatiu de lucru" ramane pentru restul.
      var textKicker = trad((activ && activ.dataset.kicker) || 'Spațiu de lucru');
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
      var stare = trad(navigator.onLine ? 'Conectat' : 'Fără conexiune');
      if (online.textContent !== stare) online.textContent = stare;
    }
  }

  /* Același arbore este bară laterală pliabilă pe desktop și sertar pe telefon.
     Permisiunile, modul simplu, starea activă și ordinea ciclului rămân identice;
     nu există o listă mobilă paralelă care să poată deriva. */
  function monteazaNavigatiaMobila() {
    var bara = $('.topbar');
    var comutator = $('#navToggleBtn');
    var fundal = $('#navBackdrop');
    var meniu = $('#tabs');
    if (!bara || !comutator || !fundal || !meniu) return;

    var mediaMobil = window.matchMedia ? window.matchMedia('(max-width: 700px)') : { matches: false };
    var cheieSidebar = 'contabo:sidebar-collapsed:v1';
    var etichetaComutator = $('.nav-toggle-label', comutator);

    /* În varianta restrânsă textul nu se vede, deci titlul devine eticheta accesibilă și
       explicația la hover. Nu suprascriem titlurile mai detaliate existente. */
    $$('#tabs > button, #tabs > a.navlink, #tabs .navlabel').forEach(function (nod) {
      if (!nod.title) nod.title = eticheta(nod);
    });
    var limba = $('#tabs > .nav-language');
    if (limba && !limba.title) limba.title = 'Limbă';

    function actualizeazaComutator() {
      var mobil = !!mediaMobil.matches;
      var deschis = mobil ? bara.classList.contains('nav-open') : !document.body.classList.contains('sidebar-collapsed');
      var textSursa = mobil ? (deschis ? 'Închide' : 'Meniu') : (deschis ? 'Restrânge' : 'Extinde');
      var explicatieSursa = mobil
        ? (deschis ? 'Închide meniul' : 'Deschide meniul')
        : (deschis ? 'Restrânge meniul lateral' : 'Extinde meniul lateral');
      var text = trad(textSursa);
      var explicatie = trad(explicatieSursa);
      if (etichetaComutator) etichetaComutator.textContent = text;
      comutator.setAttribute('aria-expanded', String(deschis));
      comutator.setAttribute('aria-label', explicatie);
      comutator.title = explicatie;
    }

    function seteazaSidebarRestransa(stransa, persista) {
      document.body.classList.toggle('sidebar-collapsed', stransa);
      if (stransa) {
        $$('.navgroup.open', meniu).forEach(function (grup) {
          grup.classList.remove('open');
          var et = $('.navlabel', grup);
          if (et) et.setAttribute('aria-expanded', 'false');
        });
      }
      if (persista) {
        try { localStorage.setItem(cheieSidebar, stransa ? '1' : '0'); } catch (_) { /* mod privat */ }
      }
      actualizeazaComutator();
      marcheazaTabeleDerulabile();
      setTimeout(marcheazaTabeleDerulabile, 220);
    }

    function inchide(restaureazaFocus) {
      var eraDeschis = bara.classList.contains('nav-open');
      bara.classList.remove('nav-open');
      document.body.classList.remove('mobile-nav-open');
      actualizeazaComutator();
      if (eraDeschis && restaureazaFocus) comutator.focus();
    }

    try {
      seteazaSidebarRestransa(localStorage.getItem(cheieSidebar) === '1', false);
    } catch (_) { seteazaSidebarRestransa(false, false); }

    comutator.addEventListener('click', function () {
      if (!mediaMobil.matches) {
        seteazaSidebarRestransa(!document.body.classList.contains('sidebar-collapsed'), true);
        return;
      }
      var deschide = !bara.classList.contains('nav-open');
      bara.classList.toggle('nav-open', deschide);
      document.body.classList.toggle('mobile-nav-open', deschide);
      actualizeazaComutator();
      if (deschide) {
        var activ = $('button[data-tab].active', meniu) || $('button, a', meniu);
        if (activ) requestAnimationFrame(function () { activ.focus(); activ.scrollIntoView({ block: 'nearest' }); });
      }
    });
    fundal.addEventListener('click', function () { inchide(true); });
    meniu.addEventListener('click', function (ev) {
      if (mediaMobil.matches || !document.body.classList.contains('sidebar-collapsed')) return;
      if (ev.target.closest('.navlabel, .nav-language')) seteazaSidebarRestransa(false, true);
    }, true);
    meniu.addEventListener('click', function (ev) {
      if (mediaMobil.matches && ev.target.closest('button[data-tab], button.nav-action, a.navlink')) inchide(false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && bara.classList.contains('nav-open')) inchide(true);
    });
    var laSchimbare = function (ev) {
      if (!ev.matches) inchide(false);
      else actualizeazaComutator();
      marcheazaTabeleDerulabile();
    };
    if (mediaMobil.addEventListener) mediaMobil.addEventListener('change', laSchimbare);
    else if (mediaMobil.addListener) mediaMobil.addListener(laSchimbare);
    document.addEventListener('contab:language', actualizeazaComutator);
    actualizeazaComutator();
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
    ['#currentPeriod', '#userBadge', '#tabs', '.topbar', '.shell > main'].forEach(function (sel) {
      var n = $(sel);
      if (n) obs.observe(n, { childList: true, characterData: true, subtree: true, attributes: true,
        // Balanța mobilă schimbă lățimea prin coloane ascunse, fără noduri noi; focusul trebuie
        // recalculat imediat când utilizatorul alege „Toate coloanele”.
        attributeFilter: ['class', 'data-mobile-columns'] });
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
