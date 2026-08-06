'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  REGISTRUL BUNURILOR DE CAPITAL (art. 305 alin. (4) Cod fiscal)
//
//  Obligatoriu prin lege si inexistent pana acum: aplicatia avea tipul de document care
//  POSTEAZA ajustarea (`ajustare_tva_bunuri_capital`), dar nu si evidenta din care se calculeaza.
//  Consecinta practica: formularul cerea contabilului sa tasteze din memorie TVA-ul dedus initial,
//  perioada de ajustare si anii ramasi — exact cele trei cifre care hotarasc suma.
//
//  Registrul se DERIVA din articole, nu se tine de mana (acelasi principiu ca la inchiderea
//  lunara): o lista intretinuta manual ramane adevarata pana la prima achizitie uitata.
//
//  Trei reguli din art. 305 care se gresesc, toate implementate explicit aici:
//
//  1. PERIOADA DE AJUSTARE INCEPE LA 1 IANUARIE al anului achizitiei (alin. (2)), nu la data
//     facturii. Un bun cumparat in decembrie 2026 consuma un an intreg din perioada in 2026 —
//     numarand de la data facturii ai gresi cu un an intreaga evidenta.
//  2. 20 de ani la bunuri IMOBILE (terenuri, constructii — si transformarile/modernizarile lor),
//     5 ani la restul (alin. (2) lit. a) si b)).
//  3. NU sunt bunuri de capital activele amortizabile in mai putin de 5 ani (alin. (1) lit. a)) —
//     de aceea registrul se uita si la durata din registrul de mijloace fixe, nu doar la cont.
//
//  Modulul e PUR: primeste vederea scoped, nu atinge baza de date.
// ─────────────────────────────────────────────────────────────────────────────

const { round2 } = require('./util');
const acc = require('./accounting');

const ANI_IMOBIL = 20;
const ANI_MOBIL = 5;
const LUNI_MINIME = 60; // sub 5 ani de amortizare nu e bun de capital (alin. (1) lit. a)

/** Bun IMOBIL dupa contul de imobilizare: 211 terenuri, 212 constructii. */
function esteImobil(cont) {
  return /^21[12]/.test(String(cont || ''));
}

/** Perioada de ajustare, in ani (art. 305 alin. (2)). */
function periodaAjustare(cont) {
  return esteImobil(cont) ? ANI_IMOBIL : ANI_MOBIL;
}

const anDin = (data) => Number(String(data || '').slice(0, 4)) || 0;

/**
 * Bunurile de capital ale firmei, derivate din articolele postate.
 *
 * Un articol intra in registru daca are SIMULTAN o linie de imobilizare (debit clasa 2, exclusiv
 * conturile de amortizare 28x si ajustari 29x) si TVA dedusa (debit 4426). Fara TVA dedusa nu
 * exista ce ajusta — un bun cumparat de la un neplatitor nu e in perimetrul art. 305.
 */
function bunuri(view, opts) {
  const o = opts || {};
  const panaLa = Number(o.anReferinta) || new Date().getUTCFullYear();
  const active = (view && view.assets) || [];
  const out = [];

  for (const e of acc.postedEntries(view || {})) {
    let tvaDedusa = 0;
    const imobilizari = [];
    for (const l of e.lines || []) {
      const d = String(l.debit || '');
      const suma = Number(l.suma) || 0;
      if (suma <= 0) continue;
      if (d.startsWith('4426')) tvaDedusa = round2(tvaDedusa + suma);
      // clasa 2, fara conturile rectificative (28x amortizari, 29x ajustari)
      else if (/^2/.test(d) && !/^2[89]/.test(d)) imobilizari.push({ cont: d, suma });
    }
    if (!tvaDedusa || !imobilizari.length) continue;

    // Un articol poate purta mai multe imobilizari; TVA-ul se repartizeaza proportional cu baza.
    const baza = round2(imobilizari.reduce((s, x) => s + x.suma, 0));
    for (const im of imobilizari) {
      // Excluderea de la alin. (1) lit. a): activele amortizabile sub 5 ani nu sunt bunuri de
      // capital. Se cauta activul corespunzator in registrul de mijloace fixe; daca nu e acolo
      // (nu s-a completat), bunul RAMANE in registru — o omisiune de nomenclator nu are voie sa
      // scoata tacit un bun din evidenta obligatorie.
      const activ = active.find((a) => String(a.cont) === im.cont
        && Math.abs((Number(a.cost) || 0) - im.suma) < 0.01);
      if (activ && Number(activ.durataLuni) > 0 && Number(activ.durataLuni) < LUNI_MINIME) continue;

      const anAchizitie = anDin(e.data);
      const durata = periodaAjustare(im.cont);
      const tvaAlocata = baza > 0 ? round2((tvaDedusa * im.suma) / baza) : 0;
      // Anii consumati se numara de la 1 IANUARIE al anului achizitiei: anul achizitiei insusi e
      // primul an al perioadei, oricat de tarziu in an ar fi fost cumparat bunul.
      const aniConsumati = Math.max(0, Math.min(durata, panaLa - anAchizitie + 1));
      const aniRamasi = Math.max(0, durata - aniConsumati);
      out.push({
        entryId: e.id,
        data: e.data,
        document: e.document || '',
        denumire: (activ && activ.denumire) || e.explicatie || ('Imobilizare ' + im.cont),
        cont: im.cont,
        imobil: esteImobil(im.cont),
        valoare: round2(im.suma),
        tvaDedusa: tvaAlocata,
        anAchizitie,
        durata,
        aniConsumati,
        aniRamasi,
        expiraDupa: anAchizitie + durata - 1,
        // TVA-ul inca supus ajustarii: partea aferenta anilor RAMASI. Asta e cifra pe care
        // formularul de ajustare o cerea tastata din memorie.
        tvaDeAjustat: round2((tvaAlocata * aniRamasi) / durata),
        inPerioada: aniRamasi > 0,
      });
    }
  }
  out.sort((a, b) => String(a.data).localeCompare(String(b.data)));
  return out;
}

/** Ajustarile deja postate (tipul `ajustare_tva_bunuri_capital`), cu semnul lor. */
function ajustari(view) {
  return acc.postedEntries(view || {})
    .filter((e) => e.tip === 'ajustare_tva_bunuri_capital')
    .map((e) => {
      let catreStat = 0; let catreFirma = 0;
      for (const l of e.lines || []) {
        const suma = Number(l.suma) || 0;
        if (String(l.debit || '').startsWith('635')) catreStat = round2(catreStat + suma);
        else if (String(l.debit || '').startsWith('4426')) catreFirma = round2(catreFirma + suma);
      }
      return { entryId: e.id, data: e.data, document: e.document || '', explicatie: e.explicatie || '', catreStat, catreFirma };
    });
}

/**
 * Registrul complet: bunurile, ajustarile efectuate si totalurile.
 * `anReferinta` (implicit anul curent) decide cati ani din perioada s-au consumat.
 */
function registru(view, opts) {
  const o = opts || {};
  const an = Number(o.anReferinta) || new Date().getUTCFullYear();
  const lista = bunuri(view, { anReferinta: an });
  const aj = ajustari(view);
  const inPerioada = lista.filter((b) => b.inPerioada);
  return {
    anReferinta: an,
    bunuri: lista,
    ajustari: aj,
    totaluri: {
      nrBunuri: lista.length,
      nrInPerioada: inPerioada.length,
      valoare: round2(lista.reduce((s, b) => s + b.valoare, 0)),
      tvaDedusa: round2(lista.reduce((s, b) => s + b.tvaDedusa, 0)),
      tvaDeAjustat: round2(inPerioada.reduce((s, b) => s + b.tvaDeAjustat, 0)),
      ajustatCatreStat: round2(aj.reduce((s, x) => s + x.catreStat, 0)),
      ajustatCatreFirma: round2(aj.reduce((s, x) => s + x.catreFirma, 0)),
    },
  };
}

module.exports = { registru, bunuri, ajustari, periodaAjustare, esteImobil, ANI_IMOBIL, ANI_MOBIL, LUNI_MINIME };
