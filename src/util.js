'use strict';

/** Rotunjire la 2 zecimale (bani). */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Format numeric romanesc: 1.234,56 */
function fmt(n) {
  const v = round2(Number(n) || 0);
  return v.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

module.exports = { round2, fmt, fmtDate, period, periodLabel, sumaInLitere, stringifyDb, naturalCompare, ultimaZiDinLuna };
