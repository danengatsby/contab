'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  CURSUL DE SCHIMB BNR (curs oficial, cu ISTORIC)
//
//  De ce cu istoric si nu doar „cursul de azi": o factura din martie se evalueaza la cursul din
//  martie, nu la cel de azi. Un feed care intoarce doar ziua curenta ar fi inutil exact la
//  operatiunea pentru care e cerut (reevaluare, import e-Factura in valuta cu data in trecut).
//
//  Regula zilelor nelucratoare (BNR nu publica sambata/duminica/sarbatori): se foloseste ULTIMUL
//  curs publicat inainte de data ceruta. `rateAt` face cautarea inapoi; nu inventeaza si nu
//  interpoleaza.
//
//  ATENTIE la `multiplier`: BNR publica unele valute la 100 de unitati (HUF, JPY, KRW, ISK…).
//  `<Rate currency="HUF" multiplier="100">1.4517</Rate>` inseamna 100 HUF = 1,4517 RON, deci
//  1 HUF = 0,014517 RON. Ignorarea atributului da o eroare de exact 100x — silentioasa si
//  catastrofala pe o reevaluare.
//
//  Indisponibilitatea feed-ului NU blocheaza nimic: cursul tastat manual ramane calea de rezerva.
// ─────────────────────────────────────────────────────────────────────────────

const log = require('./log');

// URL-urile se pot suprascrie din mediu — pentru PROBE si TESTE, ca suita sa nu iasa pe retea.
// Nu e o portita ascunsa: aceeasi conventie ca la `CONTAB_ETRANSPORT_XSD`, iar valoarea implicita
// ramane feed-ul oficial. Testele pornesc un fixture HTTP local si il indica aici, deci exercita
// drumul REAL de retea (timeout, retry, parsare), nu un stub care ar ocoli tocmai ce vrei verificat.
const URL_ZI = process.env.CONTAB_BNR_URL_ZI || 'https://www.bnr.ro/nbrfxrates.xml';
const URL_AN_TPL = process.env.CONTAB_BNR_URL_AN || 'https://www.bnr.ro/files/xml/years/nbrfxrates{AN}.xml';
const URL_AN = (an) => URL_AN_TPL.replace('{AN}', String(an));

const TIMEOUT_MS = Number(process.env.CONTAB_BNR_TIMEOUT_MS) || 20000;
const RETRIES = Number(process.env.CONTAB_BNR_RETRIES) >= 0 ? Number(process.env.CONTAB_BNR_RETRIES) : 2;
const BACKOFF_MS = Number(process.env.CONTAB_BNR_BACKOFF_MS) || 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Acelasi tipar ca `anafFetch` (timeout + retry doar pe GET), dar cu prefix propriu de log si
// plafoane proprii: un feed de curs nu trebuie sa imprumute knob-urile de timeout ale ANAF, si
// un mesaj „ANAF: reincercare" la o cerere catre BNR ar trimite diagnosticul pe pista gresita.
async function bnrFetch(what, url) {
  let lastErr = null;
  for (let i = 0; i <= RETRIES; i++) {
    if (i) {
      const wait = BACKOFF_MS * Math.pow(2, i - 1);
      log.warn('BNR: reincercare ' + i + '/' + RETRIES + ' pentru ' + what, { url, waitMs: wait });
      await sleep(wait);
    }
    let r;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      lastErr = (err && err.name === 'TimeoutError')
        ? new Error(what + ': niciun raspuns de la BNR in ' + TIMEOUT_MS + ' ms')
        : new Error(what + ': ' + ((err && err.message) || err));
      continue;
    }
    if ((r.status === 429 || r.status >= 500) && i < RETRIES) { lastErr = new Error(what + ' ' + r.status + ' (tranzitoriu)'); continue; }
    if (!r.ok) throw new Error(what + ': HTTP ' + r.status);
    return r;
  }
  throw lastErr;
}

/**
 * Parseaza XML-ul BNR (zilnic sau anual). Intoarce [{ data, cursuri: { VAL: number } }],
 * cu multiplicatorul DEJA aplicat (cursul e mereu pentru O unitate de valuta).
 * Functie PURA — testabila fara retea.
 */
function parseRates(xmlStr) {
  const out = [];
  const s = String(xmlStr || '');
  const cubeRe = /<Cube\b[^>]*\bdate="(\d{4}-\d{2}-\d{2})"[^>]*>([\s\S]*?)<\/Cube>/g;
  let m;
  while ((m = cubeRe.exec(s)) !== null) {
    const data = m[1];
    const cursuri = {};
    const rateRe = /<Rate\b([^>]*)>([^<]*)<\/Rate>/g;
    let r;
    while ((r = rateRe.exec(m[2])) !== null) {
      const attrs = r[1];
      const cur = (attrs.match(/currency="([A-Z]{3})"/) || [])[1];
      if (!cur) continue;
      const val = parseFloat(String(r[2]).trim());
      if (!Number.isFinite(val) || val <= 0) continue;
      const mult = parseFloat((attrs.match(/multiplier="(\d+)"/) || [])[1]) || 1;
      cursuri[cur] = val / mult;
    }
    if (Object.keys(cursuri).length) out.push({ data, cursuri });
  }
  return out;
}

/** Cursurile zilei curente, de la BNR. */
async function fetchDaily() {
  const r = await bnrFetch('curs BNR (zi)', URL_ZI);
  return parseRates(await r.text());
}

/** Cursurile unui an intreg (istoric), de la BNR. */
async function fetchYear(an) {
  const r = await bnrFetch('curs BNR (an ' + an + ')', URL_AN(an));
  return parseRates(await r.text());
}

/**
 * Cursul unei valute la o DATA, din colectia locala.
 * Regula zilelor nelucratoare: daca nu exista curs fix pe acea zi, se ia ultimul PUBLICAT inainte.
 * Nu se extrapoleaza in viitor: o data dinaintea primului curs cunoscut intoarce null.
 * @param {Array} colectie randuri { id: 'YYYY-MM-DD', cursuri: {...} }
 */
function rateAt(colectie, moneda, data) {
  const cur = String(moneda || '').toUpperCase();
  if (!cur || cur === 'RON') return { curs: 1, data: String(data || '').slice(0, 10), exact: true };
  const zi = String(data || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(zi)) return null;
  let best = null;
  for (const row of colectie || []) {
    const id = String(row.id || '').slice(0, 10);
    if (!id || id > zi) continue;
    if (!row.cursuri || !Number.isFinite(Number(row.cursuri[cur]))) continue;
    if (!best || id > best.id) best = { id, curs: Number(row.cursuri[cur]) };
  }
  if (!best) return null;
  return { curs: best.curs, data: best.id, exact: best.id === zi };
}

/** Valutele disponibile in colectie (pentru selectoare), sortate. */
function currencies(colectie) {
  const set = new Set();
  for (const row of colectie || []) for (const k of Object.keys(row.cursuri || {})) set.add(k);
  return [...set].sort();
}

/**
 * Aplica randuri noi peste colectie, IN LOC, idempotent (o zi deja prezenta se actualizeaza).
 * Intoarce cate zile au fost adaugate/actualizate — util pentru log si pentru testul de idempotenta.
 */
function upsertRates(colectie, randuri) {
  const byId = new Map((colectie || []).map((r) => [String(r.id), r]));
  let adaugate = 0; let actualizate = 0;
  for (const r of randuri || []) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.data || ''))) continue;
    const ex = byId.get(r.data);
    if (ex) {
      const inainte = JSON.stringify(ex.cursuri || {});
      ex.cursuri = r.cursuri;
      if (JSON.stringify(ex.cursuri) !== inainte) actualizate += 1;
    } else {
      const row = { id: r.data, cursuri: r.cursuri };
      colectie.push(row); byId.set(r.data, row); adaugate += 1;
    }
  }
  return { adaugate, actualizate };
}

module.exports = { parseRates, fetchDaily, fetchYear, rateAt, currencies, upsertRates, URL_ZI, URL_AN };
