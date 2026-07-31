'use strict';

// Reevaluarea soldurilor monetare in valuta la sfarsit de perioada (OMFP 1802/2014):
// soldul in valuta se evalueaza la cursul de inchidere; diferenta fata de valoarea contabila in lei
// se inregistreaza ca venit (765 favorabila) sau cheltuiala (665 nefavorabila) din diferente de curs.

const { round2, period: periodOf } = require('./util');
const coa = require('./chartOfAccounts');
const stmt = require('./statements');
const { postedEntries } = require('./accounting'); // reevaluarea vede doar soldurile din articole postate

// ── CE SE REEVALUEAZA: doar elementele MONETARE in valuta ────────────────────────────────────
// OMFP 1802/2014 pct. 319: disponibilitatile, creantele si datoriile in valuta se evalueaza la
// cursul de inchidere. pct. 320: elementele NEMONETARE (stocuri, imobilizari corporale) raman la
// cursul de la data tranzactiei — nu se reevalueaza niciodata.
//
// Fara filtrul asta, `candidates` propunea orice cont atins de un articol in valuta: marfa
// cumparata de la un furnizor extern (371) si venitul dintr-o livrare intracomunitara (707)
// apareau alaturi de 401 si 4111. Reevaluarea lor ar fi umflat stocul si ar fi rescris un venit
// deja realizat — exact ce interzice pct. 320.
const NEMONETARE = [
  '409', '419',               // avansuri pentru bunuri/servicii: pct. 320 alin. (3) le declara
                              // NEMONETARE — raman la cursul din ziua platii/incasarii
  '44',                       // decontari cu bugetul statului — sunt in lei prin definitie
  '471', '472', '475', '478', // cheltuieli/venituri in avans, subventii — nemonetare
  '59',                       // ajustari pentru pierderea de valoare — in lei
];

/** Elementul e MONETAR, deci se reevalueaza la cursul de inchidere? */
function esteMonetar(cod) {
  const c = String(cod || '');
  if (NEMONETARE.some((p) => c.startsWith(p))) return false;
  if (/^(16[12678]|26[79])/.test(c)) return true; // imprumuturi si creante imobilizate in valuta
  return /^[45]/.test(c);                         // creante, datorii, disponibilitati
}

/** Soldul in valuta al unui cont la o data (din e.valutaInfo): debit pe cont +, credit -. */
function foreignBalance(db, account, asOf, moneda) {
  let bal = 0;
  for (const e of postedEntries(db)) {
    if (asOf && String(e.period || periodOf(e.data)) > asOf) continue;
    const vi = e.valutaInfo; if (!vi) continue;
    if (moneda && vi.valuta !== moneda) continue;
    for (const l of (e.lines || [])) {
      if (l.debit === account) bal = round2(bal + vi.sumaValuta);
      else if (l.credit === account) bal = round2(bal - vi.sumaValuta);
    }
  }
  return bal;
}

/** Conturile monetare in valuta de reevaluat la o data: sold contabil in lei + sold in valuta (best-effort). */
function candidates(db, asOf) {
  const fb = stmt.finalBalances(db, asOf);
  const curByAcct = {};
  for (const e of postedEntries(db)) {
    if (asOf && String(e.period || periodOf(e.data)) > asOf) continue;
    const vi = e.valutaInfo; if (!vi) continue;
    for (const l of (e.lines || [])) { for (const c of [l.debit, l.credit]) if (!curByAcct[c]) curByAcct[c] = vi.valuta; }
  }
  const set = new Set(Object.keys(curByAcct).filter(esteMonetar));
  for (const c of ['5124', '5314']) if (Math.abs(fb[c] || 0) > 0.005) set.add(c);
  const out = [];
  for (const cont of set) {
    const net = round2(fb[cont] || 0);
    if (Math.abs(net) < 0.005) continue;
    const moneda = curByAcct[cont] || 'EUR';
    // `foreignBalance` intoarce soldul CU SEMN (credit = negativ), dar randul e descris peste tot
    // in perechea (marime, sens): `bookLei` e deja modulul soldului, iar sensul sta in `isAsset`.
    // Aici trebuie deci MODULUL — altfel `revalue` compara un sold valutar negativ cu o valoare
    // contabila pozitiva si iese o diferenta de ordinul dublului soldului, cu semnul inversat.
    out.push({ cont, nume: coa.accountName(cont), moneda, bookLei: round2(Math.abs(net)), isAsset: net >= 0, foreignBalance: Math.abs(foreignBalance(db, cont, asOf, moneda)) });
  }
  return out.sort((a, b) => String(a.cont).localeCompare(String(b.cont)));
}

/** Calculeaza diferenta de reevaluare pentru un cont si linia contabila aferenta. */
function revalue(account, isAsset, bookLei, foreignBal, closingRate) {
  // Soldul valutar se ia in MODUL, ca si `bookLei`: sensul (creanta/datorie) e purtat de `isAsset`,
  // nu de semnul sumei. Fara asta, un sold de datorie trimis cu semn (-1000 EUR) ar da o diferenta
  // de ordinul dublului soldului si un articol INVERS — pierderea de curs ar aparea ca venit.
  // Garda sta aici, nu doar la apelant: `items` vin din cerere, deci pot fi si altceva decat ce a
  // pus formularul.
  const revaluedLei = round2(Math.abs(Number(foreignBal) || 0) * (Number(closingRate) || 0));
  const book = round2(Math.abs(Number(bookLei) || 0));
  const diff = round2(revaluedLei - book);
  let lines = []; let sens = 'nimic';
  if (Math.abs(diff) >= 0.005) {
    const favorabil = isAsset ? diff > 0 : diff < 0; // activ care creste / datorie care scade = castig
    const amt = round2(Math.abs(diff));
    if (favorabil) { lines = [{ debit: account, credit: '765', suma: amt, explicatie: 'Diferenta favorabila de curs (reevaluare ' + account + ')' }]; sens = 'favorabila'; }
    else { lines = [{ debit: '665', credit: account, suma: amt, explicatie: 'Diferenta nefavorabila de curs (reevaluare ' + account + ')' }]; sens = 'nefavorabila'; }
  }
  return { account, revaluedLei, book, diff, sens, lines };
}

/** Construieste rezultatele + liniile pentru o reevaluare; soldul contabil/sensul se recalculeaza din date. */
function buildRevaluation(db, asOf, items) {
  const fb = stmt.finalBalances(db, asOf);
  const results = (items || []).filter((it) => it.cont && Number(it.closingRate) > 0).map((it) => {
    const net = round2(fb[it.cont] || 0);
    return revalue(it.cont, net >= 0, Math.abs(net), Number(it.foreignBalance) || 0, Number(it.closingRate));
  });
  const lines = [];
  for (const r of results) for (const l of r.lines) lines.push(l);
  const totalFavorabil = round2(results.filter((r) => r.sens === 'favorabila').reduce((s, r) => s + Math.abs(r.diff), 0));
  const totalNefavorabil = round2(results.filter((r) => r.sens === 'nefavorabila').reduce((s, r) => s + Math.abs(r.diff), 0));
  return { results, lines, totalFavorabil, totalNefavorabil };
}

module.exports = { foreignBalance, candidates, revalue, buildRevaluation, esteMonetar };
