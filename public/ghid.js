'use strict';

/*
   GHID.JS — ghidul ca PREZENTARE a aplicatiei: bara de meniu a aplicatiei sus, fiecare grup cu
   submeniurile lui, si cate o pagina de prezentare pentru fiecare submeniu.

   Nimic din structura asta NU se scrie de mana. Meniul si paginile se construiesc din DOM-ul REAL
   al aplicatiei — aceeasi sursa pe care o foloseste erp.js pentru bara de meniu:
     - grupurile si submeniurile:  #tabs .navgroup > .navlabel + .navmenu button[data-tab]
     - continutul unei pagini:     <h2> si blocurile .explain ale tabului respectiv
   Deci un tab nou aparut in aplicatie apare SINGUR in ghid, cu explicatia lui, iar o explicatie
   schimbata in produs se schimba si aici. Alternativa — un ghid scris separat — ar fi driftat de
   la prima pagina noua, si nimeni n-ar fi aflat: ghidul se citeste rar.

   Explicatiile se CLONEAZA din DOM, nu se re-serializeaza ca text: asa nu exista nicio cale prin
   care continutul sa fie reinterpretat ca marcaj (vezi regulile de escapare din CLAUDE.md).
   Singurele siruri puse de noi sunt titlurile, si acelea trec prin textContent.
*/

import { $, $$, H, api } from './core.js';

/** Desparte „📥 Documente & facturi" in pictograma + text. Aceeasi regula ca in erp.js. */
export function despartePictograma(eticheta) {
  const s = String(eticheta || '').trim();
  const m = /^([^\p{L}\p{N}]+)\s*(.*)$/u.exec(s);
  if (m && m[1].trim()) return { ic: m[1].trim(), txt: m[2].trim() };
  return { ic: '', txt: s };
}

/**
 * PUR: modelul ghidului dintr-un container de taburi. Exportat pentru test/frontend.mjs —
 * partea care se poate strica in tacere e potrivirea grup -> submeniuri, nu randarea.
 * Intoarce [{ nume, ic, itemi: [{ tab, eticheta, ic }] }].
 */
export function modelGhid(tabs) {
  if (!tabs || !tabs.querySelectorAll) return [];
  const grupuri = [];
  const noduri = tabs.querySelectorAll('.navgroup');
  for (const g of noduri) {
    const lbl = g.querySelector('.navlabel');
    if (!lbl) continue;
    const p = despartePictograma(lbl.textContent);
    const itemi = [];
    for (const b of g.querySelectorAll('.navmenu button[data-tab]')) {
      const t = b.getAttribute('data-tab');
      if (!t) continue;
      const pe = despartePictograma(b.textContent); // butoanele de navigare NU primesc bule .cinfo
      itemi.push({ tab: t, eticheta: pe.txt || t, ic: pe.ic });
    }
    if (itemi.length) grupuri.push({ nume: p.txt, ic: p.ic, itemi });
  }
  return grupuri;
}

/**
 * Textul unui element, FARA bulele de ajutor. `panel-info.js` injecteaza in fiecare <h2> un
 * `<span class="cinfo">` care contine si explicatia intreaga, deci `textContent` brut lipea
 * titlul de explicatie: butonul a iesit „Deschide «Solduri conturi (balanța de verificare)iBalanța
 * de verificare cu cele patru egalități…»". Se curata pe o CLONA — nodul din pagina nu se atinge.
 */
export function textCurat(nod) {
  if (!nod) return '';
  const c = nod.cloneNode(true);
  if (c.querySelectorAll) for (const b of c.querySelectorAll('.cinfo, .cpop, .adv')) b.remove();
  return String(c.textContent || '').replace(/\s+/g, ' ').trim();
}

/** Titlul unui tab, asa cum il vede utilizatorul in aplicatie (fara pictograma si fara bule). */
function tituluTabului(tab, deRezerva) {
  const sec = document.querySelector('#tab-' + tab);
  const h2 = sec && sec.querySelector('h2');
  if (h2) {
    const t = despartePictograma(textCurat(h2)).txt;
    if (t) return t;
  }
  return deRezerva || tab;
}

/** Explicatiile proprii ale tabului, clonate. Gol = tabul nu are inca `.explain`. */
function explicatiiTabului(tab) {
  const sec = document.querySelector('#tab-' + tab);
  if (!sec) return [];
  return Array.prototype.slice.call(sec.querySelectorAll(':scope > .card > .explain, :scope > .explain'))
    .slice(0, 3)
    .map((e) => e.cloneNode(true));
}

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

/** Pagina de prezentare a unui submeniu: titlu, explicatiile lui, si intrarea in pagina reala. */
function construiestePagina(item, grup) {
  const wrap = el('div', 'card ghid-pagina');

  const bara = el('div', 'toolbar');
  const h2 = el('h2', '', (item.ic ? item.ic + ' ' : '') + item.eticheta);
  bara.appendChild(h2);
  bara.appendChild(el('div', 'spacer'));
  const inapoi = el('button', 'btn small', '← Cuprins');
  inapoi.type = 'button';
  inapoi.addEventListener('click', arataCuprinsul);
  bara.appendChild(inapoi);
  wrap.appendChild(bara);

  wrap.appendChild(el('p', 'muted', 'Meniul ' + grup.nume + ' → ' + item.eticheta));

  const ex = explicatiiTabului(item.tab);
  if (ex.length) { for (const e of ex) wrap.appendChild(e); }
  else {
    // Fara `.explain` in produs, ghidul NU inventeaza o descriere: spune ce e si trimite la pagina.
    wrap.appendChild(el('p', '', 'Pagina „' + tituluTabului(item.tab, item.eticheta)
      + '" nu are încă o descriere proprie în aplicație. Deschide-o ca să o vezi.'));
  }

  const act = el('p', '');
  const deschide = el('button', 'btn primary', 'Deschide „' + tituluTabului(item.tab, item.eticheta) + '”');
  deschide.type = 'button';
  deschide.addEventListener('click', () => { if (window.goTab) window.goTab(item.tab); });
  act.appendChild(deschide);
  wrap.appendChild(act);
  return wrap;
}

/** Cuprinsul unui grup: cate un card pe submeniu, cu prima fraza a explicatiei. */
function construiesteGrup(grup) {
  const wrap = el('div', 'card ghid-pagina');
  const bara = el('div', 'toolbar');
  bara.appendChild(el('h2', '', (grup.ic ? grup.ic + ' ' : '') + grup.nume));
  bara.appendChild(el('div', 'spacer'));
  const inapoi = el('button', 'btn small', '← Cuprins');
  inapoi.type = 'button';
  inapoi.addEventListener('click', arataCuprinsul);
  bara.appendChild(inapoi);
  wrap.appendChild(bara);

  const lista = el('div', 'ghid-grile');
  for (const it of grup.itemi) {
    const c = el('button', 'ghid-cel');
    c.type = 'button';
    const ex = explicatiiTabului(it.tab)[0];
    // Pictograma celulei: cea a intrarii de meniu daca are, altfel emoji-ul explicatiei (`.ei`).
    // Butoanele din arbore n-au pictograma, deci fara asta toate celulele ar fi aratat „·", iar
    // emoji-ul explicatiei ar fi ramas lipit la inceputul rezumatului.
    const ei = ex && ex.querySelector && ex.querySelector('.ei');
    c.appendChild(el('span', 'ghid-cel-ic', it.ic || (ei && ei.textContent.trim()) || '·'));
    c.appendChild(el('span', 'ghid-cel-t', it.eticheta));
    if (ei) ei.remove(); // clona e a noastra; se scoate ca sa nu se repete in rezumat
    const rez = ex ? textCurat(ex).slice(0, 120) : '';
    if (rez) c.appendChild(el('span', 'ghid-cel-d', rez + (rez.length >= 120 ? '…' : '')));
    c.addEventListener('click', () => arataPagina(it, grup));
    lista.appendChild(c);
  }
  wrap.appendChild(lista);
  return wrap;
}

function panou() { return document.querySelector('#ghidPagina'); }
function acasa() { return document.querySelector('#ghidAcasa'); }

function arataCuprinsul() {
  const p = panou(); const a = acasa();
  if (p) { p.innerHTML = ''; p.classList.add('hidden'); }
  if (a) a.classList.remove('hidden');
  marcheazaActiv(null);
  const sec = document.querySelector('#tab-ghid');
  if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function arataIn(nod, cheieActiva) {
  const p = panou(); const a = acasa();
  if (!p) return;
  p.innerHTML = '';
  p.appendChild(nod);
  p.classList.remove('hidden');
  if (a) a.classList.add('hidden');
  marcheazaActiv(cheieActiva);
  if (p.scrollIntoView) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function arataPagina(item, grup) { arataIn(construiestePagina(item, grup), grup.nume); }
function arataGrup(grup) { arataIn(construiesteGrup(grup), grup.nume); }

function marcheazaActiv(nume) {
  for (const b of $$('#ghidMenu > .em-item')) b.classList.toggle('activ', !!nume && b.dataset.grup === nume);
}

function inchideToate() {
  for (const b of $$('#ghidMenu > .em-item')) b.classList.remove('open');
}

/** Bara de meniu a ghidului — oglinda meniului aplicatiei. */
function construiesteMeniu(grupuri) {
  const bar = document.querySelector('#ghidMenu');
  if (!bar) return;
  bar.innerHTML = '';
  for (const gr of grupuri) {
    const wrap = el('div', 'em-item');
    wrap.dataset.grup = gr.nume;
    const btn = el('button', '', null);
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'true');
    btn.appendChild(el('span', 'emi', gr.ic || '·'));
    btn.appendChild(document.createTextNode(gr.nume));

    const pop = el('div', 'em-pop');
    pop.setAttribute('role', 'menu');
    const toate = el('button', '', null);
    toate.type = 'button';
    toate.appendChild(el('span', 'emi', '☰'));
    toate.appendChild(el('span', 'emt', 'Tot grupul (' + gr.itemi.length + ')'));
    toate.addEventListener('click', () => { inchideToate(); arataGrup(gr); });
    pop.appendChild(toate);
    pop.appendChild(document.createElement('hr'));
    for (const it of gr.itemi) {
      const b = el('button', '', null);
      b.type = 'button';
      b.appendChild(el('span', 'emi', it.ic || '·'));
      b.appendChild(el('span', 'emt', it.eticheta));
      b.addEventListener('click', () => { inchideToate(); arataPagina(it, gr); });
      pop.appendChild(b);
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const era = wrap.classList.contains('open');
      inchideToate();
      if (!era) wrap.classList.add('open');
    });
    wrap.appendChild(btn);
    wrap.appendChild(pop);
    bar.appendChild(wrap);
  }
  document.addEventListener('click', inchideToate);
}

/** Se cheama o data, la pornire. Idempotent: o a doua chemare reconstruieste, nu dubleaza. */
/**
 * Ciclul contabil cu temeiul fiecarui pas, grupat pe faze.
 *
 * Se construieste din `/api/temei-legal` (src/temeiLegal.js), NU dintr-o lista scrisa aici:
 * aceleasi trimiteri apar si pe ecranele de lucru, iar doua copii ar ajunge sa spuna lucruri
 * diferite despre acelasi pas. Ordinea pasilor e cea din sursa — e ordinea de EXECUTIE, nu una
 * alfabetica.
 */
const FAZA_TITLU = {
  permanent: 'La fiecare operațiune (tot anul)',
  lunar: 'La închiderea lunii',
  trimestrial: 'Trimestrial',
  anual: 'La închiderea exercițiului',
};
export async function randeazaCiclu() {
  const box = document.querySelector('#cicluView');
  if (!box) return;
  let r;
  try { r = await api('/api/temei-legal'); } catch (e) { box.innerHTML = ''; return; }
  const pasi = r.pasi || [];
  const html = (r.faze || []).map((faza) => {
    const aleFazei = pasi.filter((p) => p.faza === faza);
    if (!aleFazei.length) return '';
    return `<h3>${H(FAZA_TITLU[faza] || faza)}</h3>
      <ol class="ciclu">${aleFazei.map((p) => `<li>
        <b>${H(p.nume)}</b>
        <p class="muted">${H(p.descriere)}</p>
        <ul class="ciclu-temei">${p.temei.map((x) => `<li><b>${H(x.actTitlu)}</b>${
  x.articol && x.articol !== '—' ? ', ' + H(x.articol) : ''} — ${H(x.ce)}</li>`).join('')}</ul>
      </li>`).join('')}</ol>`;
  }).join('');
  box.innerHTML = html || '<p class="muted">Ciclul contabil nu a putut fi încărcat.</p>';
}

export function initGhid() {
  randeazaCiclu();
  const tabs = $('#tabs');
  const bar = document.querySelector('#ghidMenu');
  if (!tabs || !bar) return 0;
  const grupuri = modelGhid(tabs);
  construiesteMeniu(grupuri);
  return grupuri.length;
}
