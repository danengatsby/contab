'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  FISIER DE PLATI ISO 20022 (pain.001.001.03) — ordinul de plata catre banca
//
//  Drumul de intoarcere al bancii: importul de extras exista de mult (CSV/MT940/CAMT.053), dar
//  lotul de plati catre furnizori si salariile nete se tastau una cate una in internet banking.
//
//  DOUA REGULI DE FOND, ambele deliberate:
//
//  1. Fisierul NU POSTEAZA NIMIC in contabilitate. Plata se inregistreaza cand apare in extras,
//     prin reconcilierea existenta. Daca am posta si la generare, si la import, plata s-ar
//     DUBLA — iar un fisier generat nu e o plata: banca il poate refuza, iar operatorul il poate
//     sterge. Contabilitatea urmeaza banca, nu intentia.
//
//  2. `SvcLvl/SEPA` se pune DOAR pentru EUR. Schema SEPA e prin definitie in euro; o plata interna
//     in RON marcata „SEPA" e o contradictie pe care unele banci o resping, iar altele o accepta
//     tacit si o trateaza gresit. Pentru RON se emite acelasi pain.001, fara nivelul de serviciu.
//
//  LIMITARE CUNOSCUTA, de stiut inainte de prima folosire: iesirea NU e validata fata de schema
//  oficiala ISO 20022 — spre deosebire de e-Transport, al carui XSD e versionat in repo. XSD-ul
//  pain.001 nu e disponibil public la o adresa stabila, deci verificam doar structura si
//  bine-formarea. „N-am putut verifica" nu e „e bine": prima livrare catre o banca reala ramane
//  proba care lipseste.
// ─────────────────────────────────────────────────────────────────────────────

const { round2 } = require('./util');
const { esc } = require('./xml');

/** Normalizeaza un IBAN: fara spatii, majuscule. */
function normIban(s) {
  return String(s || '').replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Validare IBAN dupa ISO 13616: lungime pe tara + restul modulo 97 == 1.
 * Nu e o euristica: un IBAN cu o cifra gresita pica aici, nu la banca, si nu dupa ce lotul a plecat.
 */
const IBAN_LEN = { RO: 24, DE: 22, FR: 27, IT: 27, ES: 24, NL: 18, BE: 16, AT: 20, BG: 22, HU: 28, PL: 28, GR: 27, PT: 25, IE: 22, CZ: 24, SK: 24, DK: 18, FI: 18, SE: 24, LU: 20, CY: 28, HR: 21, SI: 19, LT: 20, LV: 21, EE: 20, MT: 31 };
function validIban(raw) {
  const s = normIban(raw);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const tara = s.slice(0, 2);
  if (IBAN_LEN[tara] && s.length !== IBAN_LEN[tara]) return false;
  // muta primele 4 caractere la coada, litera -> numar (A=10 … Z=35), apoi mod 97
  const rearanjat = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of rearanjat) {
    const val = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const cifra of val) rest = (rest * 10 + Number(cifra)) % 97;
  }
  return rest === 1;
}

// Setul de caractere permis de SEPA (EPC Rulebook): literele latine de baza, cifre si
//   / - ? : ( ) . , ' +   plus spatiu. NIMIC altceva.
// Diacriticele romanesti NU sunt in el, iar denumirile de parteneri vin din e-Factura/SPV, deci
// CONTIN „Ș", „Ț", „ă". Bancile ori resping fisierul, ori stalcesc tacit numele — si atunci plata
// pleaca spre un beneficiar scris altfel decat in contract. Se translitereaza, nu se spera.
const SEPA_PERMIS = /[^A-Za-z0-9/\-?:().,'+ ]/g;
// Perechile care nu se rezolva prin descompunere Unicode (virgula-dedesubt romaneasca) sau care
// au o transliterare consacrata.
const TRANSLIT = {
  ș: 's', Ș: 'S', ş: 's', Ş: 'S', ț: 't', Ț: 'T', ţ: 't', Ţ: 'T',
  ß: 'ss', æ: 'ae', Æ: 'AE', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ł: 'l', Ł: 'L',
  '&': '+', '–': '-', '—': '-', '„': "'", '”': "'", '“': "'", '’': "'", '«': "'", '»': "'",
};

/**
 * Curata un text pentru campurile ISO 20022: transliterare in setul SEPA + lungime maxima.
 * Ordinea conteaza: intai perechile explicite, apoi descompunerea Unicode (care rezolva generic
 * é/ü/à ale furnizorilor straini), abia apoi inlocuirea a ce a ramas in afara setului.
 */
function txt(s, max) {
  let t = String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, ' ');
  t = t.replace(/[^\x00-\x7f]/g, (c) => (TRANSLIT[c] != null ? TRANSLIT[c] : c));
  t = t.replace(/&/g, '+');
  // NFD desface litera de semnul diacritic; \p{M} sterge semnul si ramane litera de baza.
  t = t.normalize('NFD').replace(/\p{M}/gu, '');
  t = t.replace(SEPA_PERMIS, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, max || 70);
}

/** Textul contine caractere pe care SEPA nu le accepta? (pentru avertismente in interfata) */
function needsTranslit(s) {
  return SEPA_PERMIS.test(String(s == null ? '' : s).replace(SEPA_PERMIS, (m) => m));
}

/** Identificator unic, stabil ca forma, pentru MsgId/PmtInfId/EndToEndId. */
function idSafe(prefix, s) {
  const cur = String(s || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'X';
  return (prefix + cur).slice(0, 35);
}

/**
 * Verifica un lot INAINTE de generare si intoarce lista de probleme (goala = se poate genera).
 * Separata de `build` ca interfata sa poata arata TOATE problemele deodata, nu prima.
 */
function checkPayload(p) {
  const probleme = [];
  p = p || {};
  const dbt = p.debitor || {};
  if (!txt(dbt.nume)) probleme.push('Lipseste denumirea platitorului (firma).');
  if (!dbt.iban) probleme.push('Lipseste IBAN-ul firmei platitoare (Setari → Firma).');
  else if (!validIban(dbt.iban)) probleme.push('IBAN-ul firmei platitoare este invalid: ' + normIban(dbt.iban));
  const plati = Array.isArray(p.plati) ? p.plati : [];
  if (!plati.length) probleme.push('Niciun rand de plata selectat.');
  plati.forEach((x, i) => {
    const eticheta = txt(x.beneficiar) || ('randul ' + (i + 1));
    if (!txt(x.beneficiar)) probleme.push('Randul ' + (i + 1) + ': lipseste beneficiarul.');
    if (!x.iban) probleme.push(eticheta + ': lipseste IBAN-ul beneficiarului.');
    else if (!validIban(x.iban)) probleme.push(eticheta + ': IBAN invalid (' + normIban(x.iban) + ').');
    if (!(Number(x.suma) > 0)) probleme.push(eticheta + ': suma trebuie sa fie mai mare ca zero.');
  });
  return probleme;
}

/**
 * Genereaza fisierul pain.001.001.03.
 * @param {object} p { msgId, creDtTm, execDate, moneda, debitor:{nume,iban,bic}, plati:[{beneficiar,iban,bic,suma,detalii,ref}] }
 * @throws Error cu TOATE problemele, cand lotul nu e valid.
 */
function buildPain001(p) {
  const probleme = checkPayload(p);
  if (probleme.length) { const e = new Error(probleme.join(' ')); e.status = 400; e.probleme = probleme; throw e; }

  const moneda = String(p.moneda || 'RON').toUpperCase();
  const acum = p.creDtTm || new Date().toISOString().replace(/\.\d{3}Z$/, '');
  const execDate = String(p.execDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const msgId = idSafe('MSG', p.msgId || Date.now());
  const plati = p.plati.map((x, i) => ({
    beneficiar: txt(x.beneficiar, 70),
    iban: normIban(x.iban),
    bic: txt(x.bic, 11).toUpperCase(),
    suma: round2(Number(x.suma)),
    detalii: txt(x.detalii || x.ref || '', 140),
    e2e: idSafe('E2E', x.ref || (msgId + '-' + (i + 1))),
  }));
  const total = round2(plati.reduce((s, x) => s + x.suma, 0));
  const dbt = p.debitor;

  // SEPA e prin definitie in EUR: nivelul de serviciu se emite DOAR atunci (vezi antetul).
  const svcLvl = moneda === 'EUR' ? '\n      <SvcLvl><Cd>SEPA</Cd></SvcLvl>' : '';
  const bicTag = (bic, tag) => (bic ? `\n      <${tag}><FinInstnId><BIC>${esc(bic)}</BIC></FinInstnId></${tag}>` : '');

  const tx = plati.map((x) => `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${esc(x.e2e)}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="${esc(moneda)}">${x.suma.toFixed(2)}</InstdAmt></Amt>${x.bic ? `
        <CdtrAgt><FinInstnId><BIC>${esc(x.bic)}</BIC></FinInstnId></CdtrAgt>` : ''}
        <Cdtr><Nm>${esc(x.beneficiar)}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${esc(x.iban)}</IBAN></Id></CdtrAcct>${x.detalii ? `
        <RmtInf><Ustrd>${esc(x.detalii)}</Ustrd></RmtInf>` : ''}
      </CdtTrfTxInf>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- pain.001.001.03 generat de Contabo. Fisierul NU inregistreaza plata in contabilitate:
     plata se contabilizeaza la aparitia in extrasul bancar (reconciliere). -->
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${esc(msgId)}</MsgId>
      <CreDtTm>${esc(acum)}</CreDtTm>
      <NbOfTxs>${plati.length}</NbOfTxs>
      <CtrlSum>${total.toFixed(2)}</CtrlSum>
      <InitgPty><Nm>${esc(txt(dbt.nume, 70))}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${esc(idSafe('PMT', msgId))}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${plati.length}</NbOfTxs>
      <CtrlSum>${total.toFixed(2)}</CtrlSum>${svcLvl}
      <ReqdExctnDt>${esc(execDate)}</ReqdExctnDt>
      <Dbtr><Nm>${esc(txt(dbt.nume, 70))}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${esc(normIban(dbt.iban))}</IBAN></Id></DbtrAcct>${bicTag(dbt.bic, 'DbtrAgt')}
      <ChrgBr>SLEV</ChrgBr>
${tx}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}

module.exports = { buildPain001, checkPayload, validIban, normIban, txt, needsTranslit };
