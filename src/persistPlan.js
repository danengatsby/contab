'use strict';

// Planul unui persist: CE colectii se diff-uiesc acum. Sta separat fiindca ambele drivere
// (store.js/sqlite si storePg.js/pg) au nevoie de aceeasi decizie, iar doua copii ar driftea —
// si fiindca `store.js` cere `node:sqlite` la incarcare, deci driverul pg n-are voie sa-l ceara.
//
// PROBLEMA. Diff-ul re-serializeaza fiecare rand din TOATE colectiile la fiecare persist, ca sa
// afle ce s-a schimbat: cost O(baza), nu O(schimbarii). Masurat liniar: ~101 ms la 80.000 de
// articole contabile, pe un singur proces — deci 101 ms in care nu se serveste nicio alta cerere.
//
// INDICIUL. Un apelant care STIE ce a atins poate spune `db.save(['visitors'])`; diff-ul sare
// restul colectiilor.
//
// DE CE E SIGUR SA SARI. O colectie sarita nu se scrie, dar nici snapshot-ul ei nu se atinge:
// diferenta ramane vizibila si primul diff COMPLET de dupa o va scrie. Un indiciu gresit sau uitat
// INTARZIE scrierea, nu o pierde — iar plasa de mai jos margineste intarzierea. Fara plasa ar fi
// pierdere TACUTA, motivul pentru care refactorul fusese amanat.
//
// FEREASTRA RAMASA, spusa pe fata: intre o salvare partiala si urmatorul diff complet, o schimbare
// nedeclarata traieste doar in RAM. La oprirea curata se face un persist complet (src/lifecycle.js),
// deci fereastra conteaza doar la un crash. De aceea indiciul se foloseste DELIBERAT doar unde
// apelantul chiar stie ce a atins (joburile de fundal), nu peste tot.
//
// ── PRAGUL DE TIMP TREBUIE SA FIE MAI MARE DECAT CADENTA APELANTULUI ──────────────────────────
// Pragul a fost 30 s, iar singurul apelant cu indiciu (`visitors-flush`) ruleaza la 60 s. Deci la
// FIECARE rulare plasa gasea „prea mult de la ultimul complet" si intorcea diff COMPLET: indiciul
// nu s-a activat niciodata, nici macar o data. Masurat pe functia pura, server inactiv:
// 10 rulari -> 10 diff-uri complete, 0 partiale. Optimizarea exista in cod si era moarta la rulare,
// iar comentariul din jobs.js sustinea contrariul.
//
// Cele DOUA plase raspund la intrebari diferite si raman amandoua active, dar pe cadente diferite:
// la un apelant rar (60 s) se scade prima plasa de TIMP (5 min = 1 complet la 4 partiale); la unul
// des (sub ~15 s) se scade prima plasa pe NUMAR (20 partiale). Fara diferenta asta, cea mai stransa
// o masca pe cealalta si aserttile treceau din motivul gresit.
//
// INVARIANT, verificat in suita pe CONSTANTELE REALE (test/run.js, sectiunea de persistenta):
// `SAVE_FULL_MS > 2 x cadenta celui mai rapid apelant cu indiciu` (azi `jobs.VISITORS_FLUSH_MS`) —
// altfel diff-ul partial nu e cazul obisnuit, ci exceptia, si nu merita complexitatea. Testele
// vechi comparau pragul cu el insusi (`SAVE_FULL_MS - 1`), deci treceau pentru ORICE valoare:
// verificau mecanismul, nu efectul lui. Poarta noua simuleaza cadenta reala si numara.
//
// Fereastra de crash creste de la 30 s la 5 min — dar ea margineste un BUG (un indiciu gresit),
// nu functionarea normala: un apelant fara indiciu face oricum diff complet, deci scrierea lui e
// persistata imediat. 5 minute margineste raza unui defect fara sa omoare optimizarea.

const SAVE_FULL_EVERY = Number(process.env.CONTAB_SAVE_FULL_EVERY) || 20;
const SAVE_FULL_MS = Number(process.env.CONTAB_SAVE_FULL_MS) || 5 * 60 * 1000;

/**
 * Decizia, PURA — ca sa poata fi verificata pe fiecare caz fara baza (tiparul lui `persistVerdict`
 * din jobs.js). Intoarce `null` pentru diff COMPLET, sau un Set cu colectiile de diff-uit.
 * Ordinea conditiilor conteaza: orice motiv de completitudine bate indiciul.
 * `stare`: { forceFull, partiale, dinUltimulComplet } — ultimul in ms (Infinity = niciodata).
 */
function colectiiDeDiffuit(indiciu, stare) {
  const s = stare || {};
  if (s.forceFull) return null;                          // init/restore: se rescrie tot oricum
  if (!indiciu) return null;                             // fara indiciu = comportamentul dintotdeauna
  const cerute = (Array.isArray(indiciu) ? indiciu : [indiciu]).filter((k) => typeof k === 'string' && k);
  if (!cerute.length) return null;                       // indiciu gol/invalid = nu restrange nimic
  if (s.partiale >= SAVE_FULL_EVERY) return null;        // plasa: prea multe partiale la rand
  if (!(s.dinUltimulComplet < SAVE_FULL_MS)) return null; // plasa: prea mult de la ultimul complet (si NaN/Infinity)
  return new Set(cerute);
}

/** Contorul plasei: un diff COMPLET re-armeaza fereastra, unul partial o consuma. */
function noteazaDiff(stare, only) {
  if (only) { stare.partiale += 1; return stare; }
  stare.partiale = 0;
  stare.ultimulComplet = Date.now();
  return stare;
}

/** Starea initiala: `ultimulComplet = 0` => primul persist e COMPLET (nimic dovedit inca). */
function stareNoua() { return { partiale: 0, ultimulComplet: 0 }; }

/** Traduce starea interna in forma asteptata de `colectiiDeDiffuit`. */
function stareCu(stare, forceFull) {
  return {
    forceFull: !!forceFull,
    partiale: stare.partiale,
    dinUltimulComplet: stare.ultimulComplet ? Date.now() - stare.ultimulComplet : Infinity,
  };
}

module.exports = { colectiiDeDiffuit, noteazaDiff, stareNoua, stareCu, SAVE_FULL_EVERY, SAVE_FULL_MS };
