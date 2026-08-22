'use strict';

/** Rotunjire la 2 zecimale (bani). */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Rotunjire cantitativa la 3 zecimale (kg/litri/bucati fractionare din formulare). */
function roundQty(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
}

/** Format numeric romanesc: 1.234,56 */
function fmt(n) {
  const v = round2(Number(n) || 0);
  return v.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Pluralul romanesc: 1 pas / 2 pasi / 20 DE pasi / 101 pasi / 120 DE pasi / 0 pasi.
 *  Doua praguri, nu unul: „de" apare de la 20, dar nu cand ultimele doua cifre cad in 1..19.
 *  Oglinda lui `plural` din public/core.js — mesajele de blocaj se compun si pe server. */
function plural(n, sg, pl) {
  const x = Math.abs(Math.trunc(Number(n) || 0));
  if (x === 1) return n + ' ' + sg;
  const ultimele2 = x % 100;
  const cuDe = x >= 20 && (ultimele2 === 0 || ultimele2 >= 20);
  return n + (cuDe ? ' de ' : ' ') + pl;
}

/** Data ISO (YYYY-MM-DD) -> dd.mm.yyyy */
function fmtDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Returneaza perioada YYYY-MM dintr-o data ISO. */
function period(iso) {
  return String(iso || '').slice(0, 7);
}

/** Data ISO reala, nu doar text cu forma YYYY-MM-DD (respinge 2026-02-30). */
function validIsoDate(value) {
  const iso = String(value || '');
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T00:00:00Z') : null;
  return !!d && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

const LUNI = ['', 'ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie',
  'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];

function periodLabel(p) {
  const m = String(p || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return p || '';
  return `${LUNI[Number(m[2])]} ${m[1]}`;
}

// ── Suma in litere (pentru chitante) — fara diacritice, ca restul PDF-urilor ──
const NUM_U = ['', 'unu', 'doi', 'trei', 'patru', 'cinci', 'sase', 'sapte', 'opt', 'noua', 'zece', 'unsprezece',
  'doisprezece', 'treisprezece', 'paisprezece', 'cincisprezece', 'saisprezece', 'saptesprezece', 'optsprezece', 'nouasprezece'];
const NUM_Z = ['', '', 'douazeci', 'treizeci', 'patruzeci', 'cincizeci', 'saizeci', 'saptezeci', 'optzeci', 'nouazeci'];
function sub100(n, fem) {
  if (n < 20) {
    if (fem && n === 1) return 'una';
    if (fem && n === 2) return 'doua';
    if (fem && n === 12) return 'douasprezece';
    return NUM_U[n];
  }
  const z = Math.floor(n / 10); const u = n % 10;
  return NUM_Z[z] + (u ? ' si ' + (fem && u === 1 ? 'una' : fem && u === 2 ? 'doua' : NUM_U[u]) : '');
}
function grupa(n, fem) { // 1..999
  const s = Math.floor(n / 100); const r = n % 100;
  const out = [];
  if (s === 1) out.push('o suta'); else if (s === 2) out.push('doua sute'); else if (s) out.push(NUM_U[s] + ' sute');
  if (r) out.push(sub100(r, fem));
  return out.join(' ');
}
function cuScala(n, formaUnu, plural, fem) { // '<grupa> [de] <plural>', cu forma speciala pentru 1
  if (n === 1) return formaUnu;
  const r2 = n % 100;
  const de = (r2 === 0 || r2 > 19) ? ' de ' : ' ';
  return grupa(n, fem) + de + plural;
}
/** Suma in litere pentru chitante: 1234.56 -> "o mie doua sute treizeci si patru lei si cincizeci si sase bani". */
function sumaInLitere(x) {
  const abs = Math.abs(Number(x) || 0);
  const lei = Math.floor(abs);
  const bani = Math.round((abs - lei) * 100);
  const mil = Math.floor(lei / 1e6); const mii = Math.floor((lei % 1e6) / 1000); const rest = lei % 1000;
  const parts = [];
  if (mil) parts.push(cuScala(mil, 'un milion', 'milioane', true)); // "doua milioane", nu "doi"
  if (mii) parts.push(cuScala(mii, 'o mie', 'mii', true));
  if (rest) parts.push(grupa(rest, false));
  const cuv = parts.length ? parts.join(' ') : 'zero';
  return cuv + ' lei' + (bani ? ' si ' + sub100(bani, false) + ' bani' : '');
}

// Serializarea grafului bazei nu are voie sa DOBOARE persistenta: JSON.stringify arunca
// TypeError pe BigInt (strecurat de o biblioteca, node:sqlite cu readBigInts, hrtime etc.),
// iar dupa prima aparitie TOATE save()-urile ar esua pana la restart — memoria si stocul
// diverg si datele nesalvate se pierd. BigInt devine numar (sau string peste MAX_SAFE_INTEGER);
// valorile nefinite (NaN/Infinity) devin null oricum (comportamentul JSON standard) — le
// pastram, dar ambele cazuri se SEMNALEAZA in log (o data per cheie): sunt bug-uri de amonte.
// Referintele circulare raman erori: nu au reprezentare corecta si trebuie sa se vada.
const jsonWarned = new Set();
function jsonReplacer(key, value) {
  if (typeof value === 'bigint') {
    if (!jsonWarned.has('b:' + key)) { jsonWarned.add('b:' + key); console.error('[contab] serializare: BigInt la cheia "' + key + '" — convertit; verifica sursa valorii'); }
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value.toString();
  }
  if (typeof value === 'number' && !Number.isFinite(value) && !jsonWarned.has('n:' + key)) {
    jsonWarned.add('n:' + key);
    console.error('[contab] serializare: numar nefinit la cheia "' + key + '" (devine null) — verifica calculul din amonte');
  }
  return value;
}
/** JSON.stringify tolerant pentru graful bazei (folosit de toate driverele + oglinda). */
function stringifyDb(value, space) { return JSON.stringify(value, jsonReplacer, space); }

/**
 * Serializarea RANDURILOR pentru persistenta (diff + scriere). Acelasi rezultat ca `stringifyDb`,
 * dar pe calea rapida a lui V8: un `replacer` e chemat pentru FIECARE cheie a fiecarui obiect si
 * anuleaza optimizarea interna — masurat 2,1x mai lent (120 ms vs 57 ms la 80.000 de articole).
 * Conteaza fiindca `persist()` re-serializeaza fiecare rand la fiecare scriere, ca sa poata face
 * diff-ul fata de snapshot.
 *
 * Iesirea e IDENTICA octet cu octet — verificat pe toate randurile bazei reale si pe cazurile
 * speciale: NaN si Infinity dau `null` in ambele forme (replacer-ul le returna neatinse, doar
 * avertiza), -0 da `0`, `undefined` se omite, `Date` trece prin `toJSON`. Singura diferenta e
 * BigInt: forma rapida ARUNCA, deci se cade inapoi pe `stringifyDb`, care il converteste ca pana
 * acum. Acelasi rezultat, doar pe alt drum.
 *
 * CE SE PIERDE, explicit: avertismentul de consola pentru numere nefinite nu mai apare pe calea
 * randurilor. Nu dispare din produs — oglinda JSON serializeaza graful INTREG cu `stringifyDb`
 * (la 30 s, si inainte de fiecare backup), deci un NaN ajuns in baza tot e raportat. Detectia se
 * muta de pe rand pe graf, nu se stinge.
 */
function stringifyRow(value) {
  try { return JSON.stringify(value); }
  catch (_) { return stringifyDb(value); } // BigInt (si orice altceva ce cere replacer-ul)
}

// Ordine NATURALA a id-urilor ('e2' inaintea lui 'e10'), folosita de toate sortarile cronologice
// (articole, miscari de stoc, linii din SQL). Un singur Intl.Collator, refolosit: `String.prototype.
// localeCompare(x, locale, opts)` e definit in spec EXACT ca `Collator(locale, opts).compare(...)`,
// deci rezultatul e identic — dar construirea colatorului la fiecare comparatie costa enorm intr-o
// sortare. Masurat pe 22.000 de articole: 175 ms -> 12 ms (aceeasi ordine, verificata in teste).
const naturalCollator = new Intl.Collator(undefined, { numeric: true });
function naturalCompare(a, b) { return naturalCollator.compare(String(a), String(b)); }

/**
 * Ultima zi CALENDARISTICA a lunii `period` (YYYY-MM), ca data ISO completa.
 *
 * Exista fiindca „ziua 30" ca aproximare a sfarsitului de luna produce `2026-02-30` — o data care
 * NU exista. `periodOf` e un slice, deci perioada iese corecta si nimic nu se plange; dar data
 * ajunge neatinsa in <TransactionDate> si <GLPostingDate> din SAF-T, adica la ANAF, si in toate
 * PDF-urile. JavaScript o citeste ca 2 martie, deci nici macar nu esueaza zgomotos.
 */
function ultimaZiDinLuna(period) {
  const m = String(period || '').match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!m) return null;
  const zi = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate(); // ziua 0 a lunii urmatoare
  return m[1] + '-' + m[2] + '-' + String(zi).padStart(2, '0');
}

module.exports = { round2, roundQty, fmt, fmtDate, plural, period, periodLabel, validIsoDate,
  sumaInLitere, stringifyDb, stringifyRow, naturalCompare, ultimaZiDinLuna };
