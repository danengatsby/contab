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

module.exports = { round2, fmt, fmtDate, period, periodLabel };
