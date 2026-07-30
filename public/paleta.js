'use strict';
// CAUTARE GLOBALA (Ctrl+K / ⌘K). Aplicatia are ~30 de destinatii si mii de parteneri si documente,
// iar singurul camp de cautare era cel din dictionarul contabil: orice altceva se gasea doar
// plimband meniul. Paleta cauta in trei surse deodata si DUCE utilizatorul acolo.
//
// Navigarea se citeste din DOM, nu dintr-o lista scrisa de mana: asa respecta singura modul
// simplu/expert si drepturile (intrarile ascunse nu apar), si nu poate drifta fata de meniu.
// Partenerii si inregistrarile se aduc o data per deschidere si se tin scurt in memorie —
// paleta e un ecran de cautare, nu o sursa de adevar.
import { $, $$, H, api, toast } from './core.js';

let D = {};
export function setPaletaDeps(d) { D = d; }

let CACHE = null; let CACHE_LA = 0;
const VALABIL_MS = 60000;

// diacriticele nu trebuie sa fie o bariera de cautare: „gasesti" trebuie sa gaseasca „găsești"
const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function destinatii() {
  // doar butoanele CHIAR vizibile (offsetParent) — in modul simplu intrarile tehnice lipsesc,
  // iar un rezultat catre un tab ascuns ar fi o promisiune pe care meniul n-o tine
  return $$('#tabs button[data-tab]').filter((b) => b.offsetParent !== null).map((b) => {
    const grup = b.closest('.navgroup');
    const eticheta = grup ? (grup.querySelector('.navlabel') || {}).textContent : '';
    return { fel: 'nav', text: b.textContent.trim(), sub: (eticheta || '').trim(), tab: b.dataset.tab };
  });
}

async function incarca() {
  if (CACHE && Date.now() - CACHE_LA < VALABIL_MS) return CACHE;
  const out = { parteneri: [], inregistrari: [] };
  try {
    const p = await api('/api/partners');
    // ruta intoarce o HARTA pe CUI (sau un plic cu items cand e plafonata) — vezi src/paginate.js
    const lista = Array.isArray(p) ? p : (p && Array.isArray(p.items) ? p.items : Object.values(p || {}));
    out.parteneri = lista.filter(Boolean).map((x) => ({ fel: 'partener', text: x.den || x.nume || x.cui, sub: x.cui ? 'CUI ' + x.cui : '', tab: 'parteneri' }));
  } catch (e) { /* cautarea merge si fara parteneri */ }
  try {
    const e = await api('/api/entries?limit=400');
    const lista = Array.isArray(e) ? e : (e.items || []);
    out.inregistrari = lista.map((x) => ({
      fel: 'doc',
      text: (x.document || x.tipNume || x.id),
      sub: [x.data, x.partener, x.tipNume].filter(Boolean).join(' · '),
      tab: /vanzare|livrare|bon_fiscal|factura_emisa/.test(x.tip || '') ? 'iesite' : 'intrate',
      period: x.period || String(x.data || '').slice(0, 7),
    }));
  } catch (e) { /* idem */ }
  CACHE = out; CACHE_LA = Date.now();
  return out;
}

const GRUP = { nav: 'Navigare', partener: 'Clienți & furnizori', doc: 'Documente' };
let REZ = []; let SEL = 0;

function randeaza() {
  const box = $('#paletaList'); if (!box) return;
  if (!REZ.length) { box.innerHTML = '<p class="muted" data-u="u188">Niciun rezultat. Încearcă alt cuvânt.</p>'; return; }
  let grupCurent = '';
  box.innerHTML = REZ.map((r, i) => {
    const cap = r.fel !== grupCurent ? (grupCurent = r.fel, `<div class="muted" data-u="u24">${GRUP[r.fel]}</div>`) : '';
    return cap + `<div class="gloss-item pal-item${i === SEL ? ' sel' : ''}" data-i="${i}" role="option" aria-selected="${i === SEL}" tabindex="-1">
      <b>${H(r.text)}</b>${r.sub ? `<p>${H(r.sub)}</p>` : ''}</div>`;
  }).join('');
  $$('#paletaList .pal-item').forEach((el) => el.addEventListener('click', () => alege(Number(el.dataset.i))));
  const sel = box.querySelector('.pal-item.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function cauta(q, surse) {
  const f = fold(q).trim();
  const toate = [...destinatii(), ...surse.parteneri, ...surse.inregistrari];
  if (!f) return toate.filter((x) => x.fel === 'nav').slice(0, 12); // fara text: doar unde poti merge
  const scor = (x) => {
    const t = fold(x.text); const s = fold(x.sub);
    if (t.startsWith(f)) return 0;          // potrivire de la inceput — cea mai buna
    if (t.includes(f)) return 1;
    if (s.includes(f)) return 2;
    return -1;
  };
  return toate.map((x) => ({ x, s: scor(x) })).filter((r) => r.s >= 0)
    .sort((a, b) => a.s - b.s).slice(0, 30).map((r) => r.x);
}

async function reCauta() {
  const surse = await incarca();
  REZ = cauta($('#paletaSearch').value, surse); SEL = 0; randeaza();
}

function alege(i) {
  const r = REZ[i]; if (!r) return;
  inchide();
  try {
    // documentele duc la LUNA lor: lista se filtreaza pe luna de lucru, altfel utilizatorul
    // ajunge pe tab-ul bun si tot nu vede documentul cautat
    if (r.period && D.setWorkMonth) { D.setWorkMonth(r.period); if (D.applyWorkMonth) D.applyWorkMonth(); }
    if (D.goTab) D.goTab(r.tab);
  } catch (e) { toast(e.message, true); }
}

export function deschide() {
  const m = $('#paletaModal'); if (!m) return;
  m.classList.remove('hidden');
  const inp = $('#paletaSearch'); inp.value = ''; inp.focus();
  reCauta();
}
function inchide() { const m = $('#paletaModal'); if (m) m.classList.add('hidden'); }

$('#paletaSearch') && $('#paletaSearch').addEventListener('input', reCauta);
$('#paletaClose') && $('#paletaClose').addEventListener('click', inchide);
$('#paletaModal') && $('#paletaModal').addEventListener('click', (e) => { if (e.target.id === 'paletaModal') inchide(); });
$('#paletaSearch') && $('#paletaSearch').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); SEL = Math.min(SEL + 1, REZ.length - 1); randeaza(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); SEL = Math.max(SEL - 1, 0); randeaza(); }
  else if (e.key === 'Enter') { e.preventDefault(); alege(SEL); }
});
document.addEventListener('keydown', (e) => {
  const desc = $('#paletaModal') && !$('#paletaModal').classList.contains('hidden');
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); desc ? inchide() : deschide(); return; }
  if (e.key === 'Escape' && desc) inchide();
});

// Exportate pentru testele unitare de frontend (filtrarea si ordonarea): test/frontend.mjs
export { cauta, fold };
