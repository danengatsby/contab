'use strict';

// Facturi recurente: sabloane care se genereaza periodic (lunar/trimestrial/anual).
// Functii pure — usor de testat. Generarea efectiva (articol contabil) se face in ruta, prin buildEntry.

/** Sabloanele scadente pentru o luna (period 'YYYY-MM'): active, nu deja generate, in fereastra de start. */
function dueForPeriod(templates, period) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return [];
  const m = Number(period.slice(5, 7));
  return (templates || []).filter((t) => {
    if (!t.activ) return false;
    if (t.lastGenerated && String(t.lastGenerated) >= period) return false; // deja generat pentru luna asta (sau ulterior)
    const start = String(t.startDate || period).slice(0, 7);
    if (period < start) return false; // inainte de prima luna
    const startM = Number(start.slice(5, 7));
    const freq = t.frecventa || 'lunar';
    if (freq === 'lunar') return true;
    if (freq === 'trimestrial') return (((m - startM) % 3) + 3) % 3 === 0;
    if (freq === 'anual') return m === startM;
    return false;
  });
}

/** Eticheta lizibila a frecventei. */
function freqLabel(f) {
  return { lunar: 'lunar', trimestrial: 'trimestrial', anual: 'anual' }[f] || 'lunar';
}

module.exports = { dueForPeriod, freqLabel };
