'use strict';

// Cheile UNICE ale postarilor contabile. Modulul este pur si este chemat din `db.pushEntry`,
// ultima poarta prin care intra orice articol, dar poate fi folosit si ca preflight de servicii
// inaintea unor calcule cu efecte laterale. O regula noua adaugata aici acopera automat toate
// rutele prezente si viitoare.

const SINGLETON = {
  amortizare_lunara: (e) => 'amortizare:' + e.period,
  stat_plata: (e) => 'stat-plata:' + e.period,
  plata_salarii: (e) => 'plata-salarii:' + e.period,
  impozit_profit: (e) => 'impozit-profit:' + String(e.rezultatAn || e.period || '').slice(0, 4),
  inchidere_an: (e) => 'inchidere-an:' + String(e.rezultatAn || e.period || '').slice(0, 4),
  repartizare_rezultat: (e) => 'repartizare-rezultat:' + String(e.rezultatAn || String(e.document || '').match(/\d{4}/)?.[0] || ''),
};

function norm(v) {
  return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Serie/numar comparabil intre tastare, OCR si XML: separatorii si zerourile de prezentare nu
 *  schimba identitatea documentului (`AB-00017`, `ab / 17`, `AB 17`). */
function documentNumber(v) {
  return norm(v).toUpperCase().replace(/[^A-Z0-9]+/g, '').replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, ''));
}

function partyKey(e) {
  const cui = norm(e.partenerCui).replace(/^ro/, '').replace(/[^a-z0-9]/g, '');
  // CUI-ul este identitatea autoritara. Numele ramane fallback pentru documentele istorice sau
  // pentru persoane fara CUI; altfel acele intrari n-ar avea deloc protectie centrala.
  return cui ? 'cui:' + cui : (norm(e.partener) ? 'nume:' + norm(e.partener).replace(/[^a-z0-9]+/g, '') : '');
}

function linesKey(e) {
  return (e.lines || []).map((l) => [norm(l.debit), norm(l.credit), Number(l.suma || 0).toFixed(2)].join('=')).join('|');
}

function hasAccount(value, roots) {
  const account = String(value || '').replace(/\s+/g, '');
  return roots.some((root) => account.startsWith(root));
}

/** Directia comerciala este separata de tipul monografiei: aceeasi factura nu devine alta doar
 *  fiindca operatorul a ales „utilitati” in loc de „servicii primite”. */
function direction(e) {
  const explicit = norm(e.documentDirection || e.directieDocument || e.direction);
  if (['primita', 'intrare', 'inbound', 'purchase', 'received'].includes(explicit)) return 'primita';
  if (['emisa', 'iesire', 'outbound', 'sale', 'issued'].includes(explicit)) return 'emisa';
  const lines = e.lines || [];
  if (lines.some((l) => hasAccount(l.debit, ['411', '413', '418']))) return 'emisa';
  if (lines.some((l) => hasAccount(l.credit, ['401', '403', '404', '408']))) return 'primita';
  const tip = norm(e.tip).replace(/[^a-z0-9]+/g, '_');
  if (/(?:^|_)(vanzare|emisa|livrare)(?:_|$)/.test(tip)) return 'emisa';
  if (/(?:^|_)(cumparare|achizitie|primita)(?:_|$)/.test(tip)) return 'primita';
  return '';
}

function fiscalYear(e) {
  const explicit = String(e.fiscalYear || e.exercitiuFiscal || e.rezultatAn || '');
  const found = explicit.match(/\d{4}/);
  return found ? found[0] : String(e.data || e.period || '').slice(0, 4);
}

function sourceKeys(e) {
  const source = e.sourceIdentity || {};
  const spv = norm(source.spvMessageId || source.spvMsgId || (e.spvImport && e.spvImport.msgId));
  const sha = norm(source.fileSha256 || source.sha256).replace(/[^a-f0-9]/g, '');
  const out = [];
  if (spv) out.push('spv:' + spv);
  if (/^[a-f0-9]{64}$/.test(sha)) out.push('fisier-sha256:' + sha);
  // Compatibilitate pentru articolele deja persistate. Fluxurile noi scriu identitatile
  // structurale de mai sus; cheia legacy nu este folosita in locul lor.
  if (e.dedupeKey) out.push('sursa-legacy:' + norm(e.dedupeKey));
  return out;
}

function keys(entry) {
  if (!entry || entry.stornoOf || entry.tip === 'storno') return [];
  const out = sourceKeys(entry);
  const singleton = SINGLETON[entry.tip];
  if (singleton) out.push(singleton(entry));

  // Cheia comerciala ceruta: directie + CUI/identitate partener + serie/numar normalizat +
  // exercitiu fiscal. Suma, tipul si monografia NU intra: schimbarea lor este tocmai unul dintre
  // modurile in care un al doilea exemplar al aceleiasi facturi ajungea anterior in jurnal.
  const dir = direction(entry); const party = partyKey(entry); const doc = documentNumber(entry.document);
  const year = fiscalYear(entry);
  if (!entry.system && dir && party && doc && year) out.push(['document', dir, party, doc, year].join(':'));

  // Pentru note/plati fara directie comerciala pastram doar o amprenta exacta. Astfel un retry
  // identic este prins, dar doua stingeri partiale ale aceleiasi referinte raman permise.
  if (!entry.system && !dir && party && doc && year && linesKey(entry)) {
    out.push(['exact', norm(entry.tip), year, party, doc, linesKey(entry)].join(':'));
  }
  return [...new Set(out.filter((x) => x && !x.endsWith(':')))];
}

function active(e) { return !!e && !e.stornat; }

function conflict(entries, candidate) {
  const wanted = new Set(keys(candidate));
  if (!wanted.size) return null;
  const duplicate = (entries || []).find((e) => e !== candidate && e.id !== candidate.id
    && Number(e.firmaId) === Number(candidate.firmaId) && active(e)
    && keys(e).some((k) => wanted.has(k))) || null;
  if (!duplicate) return null;
  const duplicateKeys = keys(duplicate);
  return { duplicate, keys: [...wanted].filter((k) => duplicateKeys.includes(k)) };
}

function find(entries, candidate) {
  const found = conflict(entries, candidate);
  return found && found.duplicate;
}

function duplicateError(found, context) {
  const duplicate = found.duplicate;
  const e = new Error('Postare duplicată' + (context ? ' (' + context + ')' : '') + ': există deja articolul '
    + duplicate.id + (duplicate.document ? ' — ' + duplicate.document : '')
    + '. Corectează articolul existent prin storno sau cere o derogare justificată.');
  e.status = 409; e.code = 'DUPLICATE_ENTRY'; e.duplicateId = duplicate.id; e.duplicateKeys = found.keys;
  return e;
}

function assertUnique(entries, candidate, context) {
  const found = conflict(entries, candidate);
  if (found) throw duplicateError(found, context);
  return null;
}

module.exports = {
  SINGLETON, norm, documentNumber, partyKey, direction, fiscalYear, sourceKeys,
  keys, conflict, find, duplicateError, assertUnique,
};
