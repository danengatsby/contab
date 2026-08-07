'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  CATALOGUL DURATELOR NORMALE DE FUNCTIONARE (HG 2139/2004)
//
//  Ce rezolva: durata normala de functionare se tasteaza azi de mana la punerea in functiune
//  (`durataLuni`). E cea mai frecventa eroare din zona si nu se vede: intra direct in amortizare,
//  deci in cheltuiala lunara, deci in rezultat si in impozit — ani la rand, tacut.
//
//  DECIZIA CARE CONTEAZA: catalogul NU e scris in acest fisier. Anexa la HG 2139/2004 are sute de
//  coduri cu intervale de ani; un singur interval gresit produce ani de amortizare gresita exact
//  acolo unde utilizatorul are cea mai mare incredere ca aplicatia stie mai bine decat el. Deci
//  aici sta doar MECANISMUL — parsare, cautare, sugestie — iar datele le incarca utilizatorul din
//  anexa oficiala. Un catalog scris din memorie ar fi fost mai comod si mai periculos.
//
//  NU IMPUNE, SUGEREAZA. Modulul nu intoarce niciodata „durata e X luni": intoarce INTERVALUL
//  legal (aniMin..aniMax) si echivalentul lui in luni. Alegerea din interval e a contabilului si
//  ramane a lui — de aceea nu exista niciun camp „luniSugerate" cu o valoare aleasa de noi.
//  Tentatia de a pune capatul de jos (amortizare mai rapida = cheltuiala mai mare = impozit mai
//  mic) ar fi fost o optiune fiscala luata pe tacute in numele clientului.
//
//  IN AFARA LANTULUI DE CALCUL, deliberat: `src/assets.js` NU importa acest modul, iar amortizarea
//  se calculeaza in continuare din `durataLuni` salvat pe activ. Asa catalogul ramane o unealta de
//  completare a formularului, nu o intrare in calculul unei declaratii.
//
//  Modulul e PUR: primeste text si liste, nu atinge baza de date.
// ─────────────────────────────────────────────────────────────────────────────

const { parseCsv, isHeaderRow } = require('./csv');

/** Normalizare pentru cautare: fara diacritice, litere mici, spatii stranse. */
function normalizeaza(text) {
  return String(text == null ? '' : text)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    // „ș"/„ț" cu virgula dedesubt NU se descompun in NFD, deci raman dupa taierea semnelor
    // combinate: fara linia asta, „masini de spalat" nu gaseste „mașini de spălat".
    .replace(/[șş]/gi, 's').replace(/[țţ]/gi, 't')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Codul de clasificare, normalizat pentru comparatie: „2.1.16.1.1." -> „2.1.16.1.1". */
function normalizeazaCod(cod) {
  return String(cod == null ? '' : cod).trim().replace(/\s/g, '').replace(/\.+$/, '');
}

/**
 * Interpreteaza celulele de durata. Anexa oficiala scrie intervalul intr-o singura coloana
 * („8-12"), dar cine face CSV-ul in Excel il sparge adesea in doua. Acceptam ambele forme,
 * fiindca altfel jumatate din importuri ar esua pe un detaliu de formatare, nu pe date.
 * Intoarce `null` daca nu se poate citi un interval valid — apelantul raporteaza randul,
 * nu il inghite.
 */
function citesteInterval(a, b) {
  const txt = String(a == null ? '' : a).trim();
  // forma „8-12" / „8 – 12" / „8...12" intr-o singura celula
  const m = txt.match(/^(\d+(?:[.,]\d+)?)\s*(?:-|–|—|\.{2,}|la)\s*(\d+(?:[.,]\d+)?)$/);
  let min; let max;
  if (m) {
    min = Number(m[1].replace(',', '.'));
    max = Number(m[2].replace(',', '.'));
  } else {
    min = Number(txt.replace(',', '.'));
    max = (b == null || String(b).trim() === '') ? min : Number(String(b).trim().replace(',', '.'));
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min <= 0 || max <= 0) return null;
  if (max < min) return null;
  return { aniMin: min, aniMax: max };
}

/**
 * Parseaza CSV-ul anexei: `cod;denumire;aniMin;aniMax` (sau `cod;denumire;interval`).
 * Intoarce `{ randuri, respinse }`. Randurile respinse NU se pierd tacut: un catalog incarcat pe
 * jumatate, fara sa spuna care jumatate, e mai rau decat unul lipsa — utilizatorul l-ar crede
 * complet si ar cauta degeaba un cod care n-a intrat.
 */
function parse(csv) {
  const text = csv || '';
  const rows = parseCsv(text);
  const randuri = [];
  const respinse = [];
  if (!rows.length) return { randuri, respinse };
  const start = isHeaderRow(rows[0]) ? 1 : 0;

  // NUMARUL DE LINIE trebuie sa fie cel din FISIERUL UTILIZATORULUI, altfel mesajul „linia 4" il
  // trimite la randul gresit — si cu cat fisierul are mai multe randuri goale, cu atat mai
  // departe. `parseCsv` le arunca pe cele goale, deci indexul lui NU e numarul liniei.
  // Reconstruim corespondenta din textul brut; daca cele doua nu se potrivesc (un camp citat pe
  // mai multe randuri ar strica socoteala), renuntam la pretentie si numerotam pozitiile — mai
  // bine un numar despre care se stie ce inseamna decat unul care pare exact si e gresit.
  const brute = text.split(/\r?\n/);
  const liniiCuText = [];
  for (let i = 0; i < brute.length; i++) if (brute[i].trim() !== '') liniiCuText.push(i + 1);
  const potrivit = liniiCuText.length === rows.length;

  for (let i = start; i < rows.length; i++) {
    const r = rows[i] || [];
    const linie = potrivit ? liniiCuText[i] : i + 1;
    const cod = normalizeazaCod(r[0]);
    const denumire = String(r[1] == null ? '' : r[1]).trim();
    if (!cod && !denumire) continue; // rand gol — nu e o eroare, e separator
    if (!cod) { respinse.push({ linie, motiv: 'cod de clasificare lipsa' }); continue; }
    if (!denumire) { respinse.push({ linie, cod, motiv: 'denumire lipsa' }); continue; }
    const iv = citesteInterval(r[2], r[3]);
    if (!iv) { respinse.push({ linie, cod, motiv: 'durata nu se poate citi (astept „8-12" sau doua coloane)' }); continue; }
    randuri.push({ cod, denumire, aniMin: iv.aniMin, aniMax: iv.aniMax });
  }
  return { randuri, respinse };
}

/**
 * Cauta in catalog dupa cod SAU dupa cuvinte din denumire. Toate cuvintele cerute trebuie sa
 * apara (conjunctie): „masini spalat" nu trebuie sa intoarca tot ce contine „masini".
 * Ordinea: potrivirile pe cod inaintea celor pe denumire, apoi alfabetic pe cod — un cod cautat
 * exact trebuie sa fie primul rezultat, nu al treizecilea.
 */
function cauta(catalog, q, limita) {
  const lista = Array.isArray(catalog) ? catalog : [];
  const cautare = normalizeaza(q);
  if (!cautare) return [];
  const codCautat = normalizeazaCod(q);
  const cuvinte = cautare.split(' ').filter(Boolean);
  const rez = [];
  for (const it of lista) {
    const cod = normalizeazaCod(it.cod);
    const den = normalizeaza(it.denumire);
    const peCod = cod === codCautat ? 2 : (cod.startsWith(codCautat) ? 1 : 0);
    const peDenumire = cuvinte.every((c) => den.includes(c));
    if (!peCod && !peDenumire) continue;
    rez.push({ scor: peCod, it });
  }
  rez.sort((a, b) => (b.scor - a.scor) || String(a.it.cod).localeCompare(String(b.it.cod)));
  const n = Number(limita) > 0 ? Number(limita) : 50;
  return rez.slice(0, n).map((x) => x.it);
}

/**
 * Intervalul legal pentru un cod, in ani SI in luni. Fara camp „durata recomandata": vezi antetul
 * — alegerea din interval e decizie fiscala si ramane a contabilului.
 * `null` daca nu exista codul (catalog neincarcat sau cod gresit).
 */
function sugereaza(catalog, cod) {
  const c = normalizeazaCod(cod);
  const it = (Array.isArray(catalog) ? catalog : []).find((x) => normalizeazaCod(x.cod) === c);
  if (!it) return null;
  return {
    cod: it.cod,
    denumire: it.denumire,
    aniMin: it.aniMin,
    aniMax: it.aniMax,
    luniMin: Math.round(it.aniMin * 12),
    luniMax: Math.round(it.aniMax * 12),
  };
}

/** Adevarat daca `luni` cade in intervalul legal al codului. Folosit ca AVERTISMENT, nu ca refuz:
 *  legea permite si derogari (ex. mijloace fixe achizitionate uzate), iar aplicatia nu are de unde
 *  sti cazul. Un refuz ar bloca un contabil care are dreptate. */
function inInterval(catalog, cod, luni) {
  const s = sugereaza(catalog, cod);
  if (!s) return null; // nu stim — vezi „nu am putut verifica" != „e bine"
  const l = Number(luni);
  if (!Number.isFinite(l)) return null;
  return l >= s.luniMin && l <= s.luniMax;
}

module.exports = { parse, cauta, sugereaza, inInterval, normalizeaza, normalizeazaCod, citesteInterval };
