'use strict';

// Calendarul zilelor nelucratoare folosit de termenele fiscale si de e-Factura.
// Datele fixe sunt cele nationale; sarbatorile mobile urmeaza Pastele ortodox.
// Zilele libere acordate punctual numai personalului bugetar NU intra aici: ele nu
// schimba automat ziua lucratoare a contribuabililor privati.

function isoDate(d) { return d.toISOString().slice(0, 10); }

/** Pastele ortodox in calendarul gregorian (algoritmul Meeus, baza iuliana). */
function orthodoxEaster(year) {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const monthJulian = Math.floor((d + e + 114) / 31);
  const dayJulian = ((d + e + 114) % 31) + 1;
  // Diferenta iulian-gregorian este 13 zile pentru intervalul relevant aplicatiei.
  return new Date(Date.UTC(year, monthJulian - 1, dayJulian + 13));
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function holidays(year) {
  const easter = orthodoxEaster(year);
  return new Set([
    year + '-01-01', year + '-01-02', year + '-01-06', year + '-01-07', year + '-01-24',
    isoDate(addDays(easter, -2)), // Vinerea Mare
    isoDate(easter), isoDate(addDays(easter, 1)),
    year + '-05-01', year + '-06-01',
    isoDate(addDays(easter, 49)), isoDate(addDays(easter, 50)), // Rusalii
    year + '-08-15', year + '-11-30', year + '-12-01', year + '-12-25', year + '-12-26',
  ]);
}

function parseIso(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const d = new Date(String(dateStr) + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) || isoDate(d) !== dateStr ? null : d;
}

function isWorkingDay(value) {
  const d = value instanceof Date ? value : parseIso(value);
  if (!d) return false;
  const wd = d.getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays(d.getUTCFullYear()).has(isoDate(d));
}

function nextWorkingDay(dateStr) {
  const d = parseIso(dateStr);
  if (!d) return dateStr;
  while (!isWorkingDay(d)) d.setUTCDate(d.getUTCDate() + 1);
  return isoDate(d);
}

function previousWorkingDay(dateStr) {
  const d = parseIso(dateStr);
  if (!d) return dateStr;
  while (!isWorkingDay(d)) d.setUTCDate(d.getUTCDate() - 1);
  return isoDate(d);
}

/** Adauga zile lucratoare, fara a numara ziua de pornire. */
function addWorkingDays(dateStr, count) {
  const d = parseIso(dateStr);
  if (!d) return dateStr;
  let left = Math.max(0, Number(count) || 0);
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorkingDay(d)) left -= 1;
  }
  return isoDate(d);
}

/** Numarul zilelor lucratoare standard (luni-vineri, fara sarbatori legale) dintr-o luna. */
function workingDaysInMonth(period) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return 0;
  const first = parseIso(String(period) + '-01');
  if (!first) return 0;
  let count = 0;
  const d = new Date(first.getTime());
  while (isoDate(d).slice(0, 7) === period) {
    if (isWorkingDay(d)) count += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

/**
 * Regula fiscala generala: termenul nelucrator merge in urmatoarea zi lucratoare.
 * Exceptie legala explicita: scadentele care s-ar implini la 25 decembrie devin
 * 21 decembrie sau ultima zi lucratoare ANTERIOARA acesteia.
 */
function adjustFiscalDeadline(dateStr) {
  if (/^\d{4}-12-25$/.test(String(dateStr || ''))) {
    return previousWorkingDay(String(dateStr).slice(0, 4) + '-12-21');
  }
  return nextWorkingDay(dateStr);
}

module.exports = {
  orthodoxEaster, holidays, isWorkingDay, nextWorkingDay, previousWorkingDay,
  addWorkingDays, workingDaysInMonth, adjustFiscalDeadline,
};
