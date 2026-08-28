'use strict';

// Service layer pentru configurarea firmei si a aplicatiei: datele firmei, logo-ul (validat
// PNG/JPEG pe magic bytes — apare in antetul PDF-urilor), numerotarea chitantei din seria CH,
// setarile aplicatiei si cotele fiscale configurabile. Rutele (src/routes/config.js) raman
// puncte de intrare subtiri; servirea logo-ului (citire pura) si redarea PDF raman in ruta.
//
// Autorizarea pe firma e dublata prin reqFirma; seriile de documente vin direct din
// stocksService (ensureDocSeries), nu prin ctx.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const fiscal = require('./fiscal');
const fiscalProfile = require('./fiscalProfile');
const balanceCategory = require('./balanceCategory');
const { reqFirma, ensureDocSeries } = require('./stocksService');
const { validIsoDate } = require('./util');
const dateFirma = require('./dateFirma');
const commercialFunnel = require('./commercialFunnel');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

function storedFiscalHistory(fid) {
  return fiscalProfile.historyFor(db.get(), fid);
}

function replaceFiscalHistory(fid, rows) {
  const d = db.get();
  d.fiscal_profile_history = (d.fiscal_profile_history || []).filter((r) => Number(r.firmaId) !== Number(fid))
    .concat((rows || []).map((r) => Object.assign({}, r, { firmaId: Number(fid) })));
}

/** Actualizeaza datele de PROFIL ale firmei (allowlist strict: db.pickFirmaFields). Campurile
 *  sensibile — lockedUntil, subscription, anaf, logoFile — NU se pot scrie de aici; au rute
 *  dedicate (period-lock/admin, billing, anaf/config, upload de logo validat). */
function updateCompany(fid, b, actor) {
  fid = reqFirma(fid);
  const f = db.getFirma(fid);
  const eraCompleta = dateFirma.completa(f);
  const fields = db.pickFirmaFields(b);
  if (Object.prototype.hasOwnProperty.call(fields, 'categorieRaportare')) {
    const categorie = String(fields.categorieRaportare || '').trim().toLowerCase();
    if (!['', 'micro', 'mic', 'mare'].includes(categorie)) {
      fail(400, 'Categoria contabila pentru situatiile financiare trebuie sa fie micro, mic sau mare.');
    }
    fields.categorieRaportare = categorie;
  }
  const veche = String(f.metodaEvaluareStoc || 'cmp').toLowerCase() === 'fifo' ? 'fifo' : 'cmp';
  const metodaCeruta = String(fields.metodaEvaluareStoc || veche).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(fields, 'metodaEvaluareStoc') && !['cmp', 'fifo'].includes(metodaCeruta)) {
    fail(400, 'Metoda de evaluare a stocului trebuie sa fie CMP sau FIFO.');
  }
  const noua = metodaCeruta === 'fifo' ? 'fifo' : 'cmp';
  if (noua !== veche && (db.get().stockMovements || []).some((m) => m.firmaId === fid && m.tip !== 'receptie')) {
    fail(409, 'Metoda de evaluare a stocului nu se poate schimba dupa prima iesire/transfer: ar recalcula retroactiv costurile deja inregistrate. Configureaz-o inainte de operarea stocului.');
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'metodaEvaluareStoc')) fields.metodaEvaluareStoc = noua;
  const today = new Date().toISOString().slice(0, 10);
  const beforeFiscal = fiscalProfile.snapshot(fiscalProfile.companyAt(db.scoped(fid), today));
  const fiscalChanges = {};
  for (const key of fiscalProfile.HISTORIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) fiscalChanges[key] = fields[key];
  }
  Object.assign(f, fields, { id: f.id });
  const afterFiscal = fiscalProfile.snapshot(Object.assign({}, beforeFiscal, fiscalChanges));
  const fiscalChanged = fiscalProfile.HISTORIC_FIELDS.some((k) => JSON.stringify(beforeFiscal[k]) !== JSON.stringify(afterFiscal[k]));
  let revision = null;
  if (fiscalChanged) {
    // Clientii legacy ai /api/company nu aveau conceptul de data efectiva: pentru ei schimbarea
    // ramane retroactiva (1900). UI-ul nou trimite explicit fiscalValidFrom=today, iar reviziile
    // istorice/future folosesc ruta dedicata. Astfel nu rupem integrari vechi, dar nici nu le
    // atribuim tacit o data pe care n-au declarat-o.
    const effective = validIsoDate(b && b.fiscalValidFrom) ? b.fiscalValidFrom : '1900-01-01';
    const recordedAt = new Date().toISOString();
    let history = storedFiscalHistory(fid);
    if (!history.length) {
      history = [{ id: db.nextId('fpr'), firmaId: fid, validFrom: '1900-01-01', validTo: null, values: beforeFiscal,
        note: 'Fotografie initiala creata automat', recordedAt, createdAt: recordedAt,
        recordedAtSource: 'baseline-on-first-revision', createdBy: actor && actor.id || null }];
    }
    const r = fiscalProfile.addRevision(f, effective, fiscalChanges, {
      id: db.nextId('fpr'), userId: actor && actor.id, firmaId: fid, history,
      note: 'Actualizare din formularul firmei', recordedAt,
    });
    replaceFiscalHistory(fid, r.history);
    delete f.fiscalHistory;
    Object.assign(f, r.currentValues);
    revision = r.revision;
  }
  if (dateFirma.completa(f)) {
    // O firma veche deja completa primeste doar baseline-ul. Se numara exclusiv tranzitia
    // observata incompleta -> completa, dupa aceeasi definitie folosita in „Primii pasi”.
    commercialFunnel.markEntity(db.get(), f, 'company_configured', { count: !eraCompleta });
    // Daca documentul exista dinaintea instrumentarii, ii atasam marcajul fara conversie noua.
    if ((db.get().entries || []).some((e) => Number(e.firmaId) === Number(fid) && !e.system)) {
      commercialFunnel.markEntity(db.get(), f, 'first_document', { count: false });
    }
  }
  db.save();
  return { company: f, revision };
}

/** Revizie fiscala datata, append-only. Campurile de identitate si configurarea tehnica nu pot
 *  intra pe aceasta cale; `fiscalProfile.addRevision` accepta numai allowlist-ul fiscal. */
function addFiscalRevision(fid, body, actor) {
  fid = reqFirma(fid);
  const f = db.getFirma(fid);
  const b = body && typeof body === 'object' ? body : {};
  const changes = b.changes && typeof b.changes === 'object' && !Array.isArray(b.changes) ? b.changes : {};
  if (!Object.keys(changes).length) fail(400, 'Revizia trebuie sa contina cel putin un camp fiscal.');
  const r = fiscalProfile.addRevision(f, b.validFrom, changes, {
    id: db.nextId('fpr'), userId: actor && actor.id, note: b.note,
    firmaId: fid, history: storedFiscalHistory(fid), recordedAt: new Date().toISOString(),
  });
  replaceFiscalHistory(fid, r.history);
  delete f.fiscalHistory;
  // Campurile plate raman o oglinda a profilului valabil AZI pentru codul legacy si exporturi.
  Object.assign(f, r.currentValues);
  db.save();
  return { company: f, revision: r.revision, history: r.history };
}

/** Confirma anual categoria situatiilor financiare. Reviziile sunt append-only: o reconfirmare
 *  marcheaza decizia precedenta drept supersedata, fara sa-i stearga indicatorii/actorul/hash-ul. */
function confirmBalanceCategory(fid, body, actor, permissionRole) {
  fid = reqFirma(fid);
  const d = db.get();
  const view = db.scoped(fid);
  const record = balanceCategory.buildConfirmation(view, body, actor, db.nextId('bch'), permissionRole);
  d.balance_category_history = Array.isArray(d.balance_category_history) ? d.balance_category_history : [];
  const previous = balanceCategory.confirmationFor(
    d.balance_category_history.filter((x) => Number(x.firmaId) === fid), record.year);
  if (previous) {
    previous.supersededBy = record.id;
    previous.supersededAt = record.confirmedAt;
  }
  d.balance_category_history.push(record);
  db.save();
  return {
    confirmation: record,
    assessment: balanceCategory.assess(db.scoped(fid), record.year, {
      averageEmployees: record.indicatorOverrides && record.indicatorOverrides.numarMediuSalariati,
    }),
    history: balanceCategory.activeRows(d.balance_category_history.filter((x) => Number(x.firmaId) === fid)),
  };
}

/** Seteaza logo-ul firmei din fisierul deja salvat de multer: doar PNG/JPEG (validate pe
 *  magic bytes, nu pe extensie — PDF-urile nu accepta alte formate); logo-ul vechi se sterge. */
function setLogo(fid, filePath) {
  fid = reqFirma(fid);
  let head;
  try { head = fs.readFileSync(filePath).slice(0, 4); } catch (e) { fail(400, 'Fisier ilizibil.'); }
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
  const isJpg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
  if (!isPng && !isJpg) {
    try { fs.unlinkSync(filePath); } catch (_) { /* */ }
    fail(400, 'Logo-ul trebuie sa fie PNG sau JPEG (PDF-urile nu accepta alte formate).');
  }
  const f = db.getFirma(fid);
  if (f.logoFile) { try { fs.unlinkSync(path.join(db.UPLOAD_DIR, f.logoFile)); } catch (_) { /* logo vechi deja sters */ } }
  f.logoFile = path.basename(filePath);
  db.save();
  return { logoFile: f.logoFile, format: isPng ? 'PNG' : 'JPEG' };
}

/** Sterge logo-ul (fisier + camp); lipsa logo-ului NU e eroare (contract istoric). */
function deleteLogo(fid) {
  fid = reqFirma(fid);
  const f = db.getFirma(fid);
  if (f && f.logoFile) {
    try { fs.unlinkSync(path.join(db.UPLOAD_DIR, f.logoFile)); } catch (_) { /* deja sters */ }
    delete f.logoFile;
    db.save();
  }
}

/** Chitanta pentru o incasare in numerar (531x): numarul se atribuie din seria CH la prima
 *  tiparire si se REFOLOSESTE la retiparire (nu consuma serie). Erorile ajung text in ruta. */
function assignChitanta(fid, entryId) {
  fid = reqFirma(fid);
  const d = db.get();
  const e = d.entries.find((x) => x.id === entryId && (x.firmaId == null ? d.firmaActiva : x.firmaId) === fid);
  if (!e) fail(404, 'Inregistrare inexistenta');
  const suma = e.lines.reduce((s, l) => s + (/^531/.test(String(l.debit)) ? l.suma : 0), 0);
  if (suma <= 0) fail(400, 'Inregistrarea nu este o incasare in numerar (531x) — chitanta se emite doar pentru incasari in casa.');
  let justAssigned = false;
  if (!e.chitantaNr) {
    const s = ensureDocSeries(d, fid).CH;
    e.chitantaNr = s.serie + '-' + String(s.next).padStart(5, '0');
    s.next += 1;
    justAssigned = true;
    db.save();
  }
  return { entry: e, suma: Math.round(suma * 100) / 100, nr: e.chitantaNr, justAssigned };
}

// Setarile aplicatiei (globale) scriabile prin /api/settings — ALLOWLIST STRICT.
// Restul (authSecret, smtp, fiscal, docSeries, backup...) se ating DOAR prin rutele
// lor dedicate (cu requireAdmin) sau deloc; un Object.assign brut ar fi permis unui
// utilizator autentificat sa scrie authSecret si sa forjeze token-uri de admin.
const USER_SETTINGS = new Set([]);                          // (niciuna deocamdata)
const ADMIN_SETTINGS = new Set(['useAI', 'selfRegister']);  // setari GLOBALE — doar admin
const PUBLIC_SETTINGS = ['useAI', 'selfRegister', 'tvaStandard', 'tvaRedus']; // ce se intoarce clientului

/** Setarile aplicatiei (globale): merge peste cele existente, DOAR chei din allowlist.
 *  Cheile de admin cer rol de admin; orice cheie necunoscuta -> 403 (nu se scrie nimic). */
function updateSettings(b, isAdmin) {
  const d = db.get();
  const src = (b && typeof b === 'object' && !Array.isArray(b)) ? b : {};
  const upd = {};
  for (const k of Object.keys(src)) {
    if (USER_SETTINGS.has(k) || (isAdmin && ADMIN_SETTINGS.has(k))) upd[k] = src[k];
    else { const e = new Error('Setare nepermisa: ' + k); e.status = 403; throw e; }
  }
  d.settings = Object.assign({}, d.settings, upd);
  db.save();
  // NU intoarce obiectul intreg (contine authSecret/smtp.pass) — doar cheile publice
  const safe = {};
  for (const k of PUBLIC_SETTINGS) if (d.settings[k] !== undefined) safe[k] = d.settings[k];
  return { settings: safe };
}

/** Publica append-only un FiscalRuleSet. Nu exista update/reset: o corectie devine o versiune
 * noua si pastreaza astfel rezultatele si arhivele vechi verificabile dupa hash. */
function setFiscalConfig(b) {
  const d = db.get();
  if (b && b.reset) { const e = new Error('FiscalRuleSet-urile publicate sunt imuabile si nu pot fi resetate.'); e.status = 409; throw e; }
  const ruleSet = fiscal.createRuleSet(b || {});
  d.fiscalRuleSets = Array.isArray(d.fiscalRuleSets) ? d.fiscalRuleSets : [];
  d.fiscalRuleSets.push(JSON.parse(JSON.stringify(ruleSet)));
  db.save();
  fiscal.configureRuleSets(d.fiscalRuleSets);
  return { ruleSet, current: fiscal.rulesAt(ruleSet.validFrom).rates };
}

module.exports = { updateCompany, addFiscalRevision, confirmBalanceCategory, setLogo, deleteLogo, assignChitanta, updateSettings, setFiscalConfig };
