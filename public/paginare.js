'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  PAGINARE — o singură implementare, folosită de toate listele lungi.
//
//  Paginile lungi din aplicație sunt de două feluri, iar remediul diferă:
//   - lungi din TEANC DE PANOURI (Setări, Stocuri) → sparte pe pagini tematice;
//   - lungi din DATE (jurnal de audit 10.770 px, plan de conturi, cartea mare) → aici.
//  Pentru a doua categorie repoziționarea n-ar ajuta pe nimeni: rândurile sunt multe pentru că
//  ai multe înregistrări. Se taie în pagini.
//
//  Două regimuri, aceeași interfață pentru cine o folosește:
//   - SERVER: ruta acceptă `?limit&offset` și întoarce plicul { items, total, offset, limit }
//     (vezi src/paginate.js). Se cer doar rândurile afișate — singurul regim care chiar scade
//     memoria și traficul.
//   - CLIENT: datele sunt deja în memorie (planul de conturi vine în META, cartea mare vine
//     întreagă dintr-un calcul). Aici paginarea e doar de AFIȘARE — dar exact asta doare:
//     700 de rânduri construite ca HTML sunt lente de randat și imposibil de citit.
//
//  Funcțiile de calcul sunt PURE și exportate separat, ca să poată fi verificate fără DOM
//  (test/frontend.mjs). Randarea e subțire deasupra lor.
// ─────────────────────────────────────────────────────────────────────────────
import { $, H } from './core.js';

export const MARIMI = [50, 100, 250, 500];
export const MARIME_IMPLICITA = 50;

/**
 * Starea unei paginări, din total + poziție. PURĂ.
 * `offset` se NORMALIZEAZĂ: o poziție dincolo de sfârșit (ultima pagină golită după o ștergere
 * sau după un filtru mai strict) ar lăsa altfel un tabel gol peste date care există — bug care
 * arată exact ca „nu am date".
 */
export function stare(total, offset, limit) {
  const t = Math.max(0, Number(total) || 0);
  const l = Math.max(1, Number(limit) || MARIME_IMPLICITA);
  const pagini = Math.max(1, Math.ceil(t / l));
  let off = Math.max(0, Number(offset) || 0);
  if (off >= t) off = (pagini - 1) * l;          // dincolo de sfârșit → ultima pagină
  off = Math.floor(off / l) * l;                  // aliniere la marginea paginii
  const pagina = Math.min(pagini, Math.floor(off / l) + 1);
  return {
    total: t, limit: l, offset: off, pagina, pagini,
    deLa: t ? off + 1 : 0,
    panaLa: Math.min(off + l, t),
    prima: pagina <= 1,
    ultima: pagina >= pagini,
    // Controalele apar când există mai mult de o pagină — adică raportat la limita CHIAR folosită,
    // nu la cea mai mică mărime din listă. Prima formă cerea `t > min(MARIMI)` (50) și a produs un
    // bug adevărat: cartea mare paginează câte 10 conturi, deci la 19 conturi lista era tăiată la
    // 10 și bara NU se randa — nouă conturi rămâneau inaccesibile, fără nimic care să arate că
    // există. Prins în browser, nu în teste: acolo scrisesem aceeași regulă greșită.
    necesara: t > l,
  };
}

/** Textul „21–40 din 893". PUR — separat, fiindcă apare și în afara controalelor. */
export function rezumat(s, substantiv) {
  const n = substantiv || 'rânduri';
  if (!s.total) return 'niciun rând';
  if (s.total <= s.limit) return s.total + ' ' + n;
  return s.deLa + '–' + s.panaLa + ' din ' + s.total + ' ' + n;
}

/** HTML-ul barei de control. PUR (întoarce un șir), ca să poată fi verificat fără DOM. */
export function controaleHtml(s, id, substantiv) {
  if (!s.necesara) return '';
  // Mărimea curentă intră în listă chiar dacă nu e una dintre cele standard (cartea mare merge pe
  // 10 conturi). Fără asta, selectul ar fi arătat o valoare pe care utilizatorul n-a ales-o.
  const marimi = [...new Set([...MARIMI, s.limit])].sort((x, y) => x - y);
  const optiuni = marimi.map((m) => `<option value="${m}"${m === s.limit ? ' selected' : ''}>${m} / pagină</option>`).join('');
  return `<div class="paginare" data-pg="${H(id)}">
    <span class="muted">${H(rezumat(s, substantiv))}</span>
    <span class="spacer"></span>
    <button type="button" class="btn small pg-prim" ${s.prima ? 'disabled' : ''} aria-label="Prima pagină">« Prima</button>
    <button type="button" class="btn small pg-inapoi" ${s.prima ? 'disabled' : ''} aria-label="Pagina anterioară">‹ Înapoi</button>
    <span class="muted pg-pozitie">pagina ${s.pagina} din ${s.pagini}</span>
    <button type="button" class="btn small pg-inainte" ${s.ultima ? 'disabled' : ''} aria-label="Pagina următoare">Înainte ›</button>
    <button type="button" class="btn small pg-ultim" ${s.ultima ? 'disabled' : ''} aria-label="Ultima pagină">Ultima »</button>
    <select class="pg-marime" aria-label="Rânduri pe pagină">${optiuni}</select>
  </div>`;
}

/**
 * Leagă butoanele dintr-un container deja randat. `onCere(offset, limit)` primește noua poziție.
 * Se apelează DUPĂ ce HTML-ul a fost pus în pagină.
 */
export function leaga(container, s, onCere) {
  const box = (typeof container === 'string' ? $(container) : container);
  if (!box) return;
  const bara = box.querySelector('.paginare');
  if (!bara) return;
  const du = (off) => onCere(Math.max(0, off), s.limit);
  const b = (cls, fn) => { const el = bara.querySelector(cls); if (el) el.addEventListener('click', fn); };
  b('.pg-prim', () => du(0));
  b('.pg-inapoi', () => du(s.offset - s.limit));
  b('.pg-inainte', () => du(s.offset + s.limit));
  b('.pg-ultim', () => du((s.pagini - 1) * s.limit));
  const sel = bara.querySelector('.pg-marime');
  // La schimbarea mărimii se revine la ÎNCEPUT, deliberat: păstrarea offset-ului ar arunca
  // utilizatorul într-o pagină arbitrară din mijloc, fără nicio legătură cu ce citea.
  if (sel) sel.addEventListener('change', () => onCere(0, Number(sel.value) || MARIME_IMPLICITA));
}
