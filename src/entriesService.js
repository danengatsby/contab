'use strict';

// Service layer pentru articolele contabile: creare (cu descarcare automata de gestiune CMP/FIFO
// din liniile de stoc), stergere (cu garda pe perioada inchisa), facturi recurente (sabloane +
// generare pe perioada), blocarea perioadei si TVA la incasare (exigibilitate). Rutele
// (src/routes/entries.js) raman puncte de intrare subtiri.
//
// buildEntry/upsertPartner raman infrastructura partajata in server.js (folosite si de rutele
// de banca/ANAF/salarizare) si vin ca dependente in `deps` — acelasi tipar ca in anafService.
// Autorizarea pe firma e dublata la nivel de serviciu prin reqFirma (refolosit din
// stocksService): firma explicita si existenta, fara fallback pe firmaActiva.

const db = require('./db');
const coa = require('./chartOfAccounts');
const stocks = require('./stocks');
const recurring = require('./recurring');
const fiscalProfile = require('./fiscalProfile');
const extractQuality = require('./extractQuality'); // guard de scriere derivat din profilul fiscal
const payrollHistory = require('./payrollHistory');
const leasingService = require('./leasingService');
const permissions = require('./permissions');
const tvaArt310 = require('./tvaArt310');
const { reqFirma } = require('./stocksService');
const { round2, period: periodOf } = require('./util');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

// Fluxul de stare al unui articol: ciorna -> validat -> aprobat -> POSTAT. Doar postat intra in
// contabilitate (vezi accounting.isPosted). Articolele vechi/create direct n-au `status` => postat.
// Odata postat, starea nu se mai schimba: corectia se face prin STORNO (nu retrogradare).
const ENTRY_STATES = ['ciorna', 'validat', 'aprobat', 'postat'];
function entryState(e) { return e.status || 'postat'; }

function isTreasuryEntry(e) {
  if (!e) return false;
  if (e.bankTransactionId || e.tip === 'plata_salarii') return true;
  return (e.lines || []).some((line) => /^(?:512|531|541|542|581)/.test(String(line.debit || ''))
    || /^(?:512|531|541|542|581)/.test(String(line.credit || '')));
}

function actorId(actor) {
  const n = Number(actor && actor.id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function actorName(actor) {
  return String((actor && actor.username) || '').slice(0, 80) || null;
}

function canTransition(actor, fid, target) {
  // Apelurile interne vechi, fara actor, raman compatibile; rutele HTTP trimit intotdeauna actorul.
  if (!actor) return true;
  const action = { validat: 'entry.validate', aprobat: 'entry.approve', postat: 'entry.post' }[target];
  return !!action && permissions.can(actor, fid, action, db.getFirma(fid));
}

/** Separarea initiator–aprobator este o politica explicita a firmei si devine efectiva numai
 *  cand exista cel putin doi membri activi. Astfel o plecare din echipa nu blocheaza definitiv
 *  contabilitatea unei firme ramase temporar cu un singur operator. */
function makerCheckerRequired(fid) {
  const d = db.get(); const f = db.getFirma(fid);
  if (!f || f.controlDublu !== true) return false;
  const members = (d.users || []).filter((u) => u.role !== 'admin' && !u.pending
    && Array.isArray(u.firme) && u.firme.includes(Number(fid))
    && !(u.drepturi && u.drepturi.readonly)
    && canTransition(u, fid, 'postat'));
  return members.length >= 2;
}

function markEntryActor(entry, actor, status) {
  const id = actorId(actor); const at = new Date().toISOString();
  entry.createdAt = entry.createdAt || at;
  if (id != null) entry.createdBy = entry.createdBy == null ? id : entry.createdBy;
  if (actorName(actor) && !entry.createdByName) entry.createdByName = actorName(actor);
  entry.statusHistory = Array.isArray(entry.statusHistory) ? entry.statusHistory : [];
  entry.statusHistory.push({ status, by: id, username: actorName(actor), at });
}

/** Creeaza un articol contabil; liniile de stoc genereaza si descarcarea la metoda firmei (CMP/FIFO)
 *  (miscarile + liniile COGS intra atomic cu articolul — nicio scriere la eroare). */
function createEntry(fid, b, deps) {
  fid = reqFirma(fid); b = b || {};
  if (deps && deps.actor) permissions.assert(deps.actor, fid, 'write', db.getFirma(fid));
  const f = Object.assign({}, b.fields || {});
  const stocLines = Array.isArray(f.stoc) ? f.stoc.filter((s) => s && s.productId && Number(s.cantitate) > 0) : [];
  if (stocLines.length) f.cost = 0; // descarcarea vine din stoc, nu din campul manual — evita dubla inregistrare
  let entry;
  try { entry = deps.buildEntry(b.tip, f, b.fileId, fid); }
  catch (e) { fail(400, e.message); }
  db.assertPeriodOpen(fid, entry.data, 'Inregistrarea'); // nu se posteaza intr-o luna inchisa
  // Guard de scriere derivat din profilul fiscal: opreste datele clar incompatibile cu regimul
  // (ex. neplatitor de TVA care colecteaza TVA). Advisory-ul ramane in fiscalControls.
  const gViol = fiscalProfile.entryGuard(fiscalProfile.profileAt(db.scoped(fid), entry.data || entry.period), entry);
  if (gViol) fail(400, gViol);
  const actor = deps && deps.actor;
  // Intr-o echipa, butonul simplu „salveaza” nu poate ocoli controlul dublu: articolul intra in
  // flux ca ciorna. Intr-o firma cu un singur om comportamentul istoric (postare directa) ramane.
  if (b.ciorna || makerCheckerRequired(fid)
      || (actor && isTreasuryEntry(entry) && !permissions.can(actor, fid, 'treasury.approve', db.getFirma(fid)))) {
    entry.status = 'ciorna';
  }
  markEntryActor(entry, actor, entryState(entry));
  if (entryState(entry) === 'postat') leasingService.assertEntryCanPost(fid, entry);
  const d = db.get();
  let sourceDoc = null;
  if (b.fileId) {
    sourceDoc = (d.documents || []).find((doc) => String(doc.id) === String(b.fileId)
      && Number(doc.firmaId) === Number(fid));
    if (!sourceDoc) fail(400, 'Documentul sursa nu exista in firma activa.');
  }
  const spvMessageId = b.spvMsgId || (sourceDoc && sourceDoc.spvMsgId) || null;
  const fileSha256 = sourceDoc && sourceDoc.sha256 || null;
  if (spvMessageId) entry.spvImport = { msgId: spvMessageId, at: new Date().toISOString() };
  if (spvMessageId || fileSha256) entry.sourceIdentity = {
    ...(spvMessageId ? { spvMessageId: String(spvMessageId) } : {}),
    ...(fileSha256 ? { fileSha256: String(fileSha256) } : {}),
  };
  // Cheie legacy pentru articolele/instalarile care nu cunosc inca sourceIdentity. Cheia
  // comerciala centrala ramane activa indiferent de prezenta fisierului.
  if (spvMessageId) entry.dedupeKey = 'spv:' + String(spvMessageId);
  else if (b.fileId) entry.dedupeKey = 'upload:' + String(b.fileId);
  let stocInfo = null;
  let stagedStockMovements = [];
  if (stocLines.length) {
    const v = db.scoped(fid);
    let r;
    try { r = stocks.saleCogs(v.products, v.stockMovements, stocLines, { fid, data: entry.data, document: entry.document, entryId: entry.id, nextId: () => db.nextId('sm'), metoda: stocks.metodaFirma(v) }); }
    catch (e) { fail(400, e.message); }
    if (entryState(entry) === 'postat' && r.lipsuri.length) {
      fail(409, 'Stoc insuficient: ' + r.lipsuri.map((x) => x.denumire + ' — lipsa ' + x.lipsa).join('; ')
        + '. Salveaza documentul ca ciorna sau inregistreaza receptiile lipsa inainte de postare.');
    }
    if (entryState(entry) === 'postat') {
      const drift = stocks.valuationDrift(v, r.newMovements);
      if (drift) fail(409, 'Documentul retroactiv ar recalcula iesirea deja postata ' + drift.movementId
        + ' (' + drift.data + '). Storneaza si reia documentele de stoc in ordine cronologica.');
    }
    for (const ln of r.cogsLines) {
      if (!coa.getAccount(ln.debit) || !coa.getAccount(ln.credit)) fail(400, 'Cont de descarcare inexistent in plan: ' + ln.debit + '/' + ln.credit);
    }
    // Retinem granita si marcam liniile calculate: la postarea unei ciorne costul se recalculeaza
    // pe stocul disponibil ATUNCI, nu ramane fotografia veche de la creare.
    entry.stocBaseLineCount = entry.lines.length;
    for (const ln of r.cogsLines) entry.lines.push(Object.assign({}, ln, { stocAuto: true }));
    entry.stocMovementIds = r.newMovements.map((m) => m.id);
    stagedStockMovements = r.newMovements;
    stocInfo = { cogsTotal: r.total, warns: r.warns, lipsuri: r.lipsuri, movements: r.newMovements.length };
  }
  const requestedOverride = b.duplicateOverride;
  const duplicateOverride = requestedOverride
    ? (typeof requestedOverride === 'object' ? requestedOverride : {
      duplicateId: b.duplicateId, reason: b.duplicateReason || b.motivDuplicat,
    })
    : null;
  if (entryState(entry) === 'postat') {
    const view = db.scoped(fid);
    tvaArt310.assertCanPost(view, entry, fiscalProfile.profileAt(view, entry.data || entry.period));
  }
  db.pushEntry(entry, {
    context: 'articol contabil', actor, duplicateOverride,
    auditDuplicateOverride: deps && deps.auditDuplicateOverride,
  });
  // Miscarile sunt aplicate abia dupa ce TOATE gardele centrale (inclusiv anti-duplicat si auditul
  // derogarii) au acceptat articolul. Altfel un 409 lasa stoc fantoma fara articol contabil.
  for (const mv of stagedStockMovements) d.stockMovements.push(mv);
  deps.upsertPartner(fid, entry);
  if (!b.automat) inregistreazaInterventia(fid, b, entry, f);
  db.save();
  return { entry, stoc: stocInfo };
}

/**
 * INTERVENTIA OPERATORULUI: ce a corectat omul fata de ce a citit masina.
 *
 * Se calculeaza aici, nu se cere de la interfata, tocmai ca sa nu poata fi uitata sau falsificata:
 * documentul poarta extragerea originala (`doc.extras`), articolul poarta ce s-a salvat, iar
 * diferenta e o consecinta, nu o declaratie. `motiv` (optional, din formular) adauga contextul pe
 * care datele nu-l pot spune — de ce a fost gresit, nu doar ce.
 *
 * Se inregistreaza si interventiile GOALE (om care confirma extragerea fara sa schimbe nimic):
 * fara ele, rata de corectie pe furnizor ar fi calculata doar din esecuri si ar arata mereu 100%.
 */
function inregistreazaInterventia(fid, b, entry, campuriSalvate) {
  if (!b.fileId) return null;
  const d = db.get();
  const doc = (d.documents || []).find((x) => x.id === b.fileId && x.firmaId === fid);
  if (!doc || !doc.extras) return null;            // document fara extragere (upload-only, import SPV)
  if (doc.extras.autoPostat || doc.interventieId) return null; // deja consemnat o data
  const ex = doc.extras;
  const diff = extractQuality.diferente(ex.fields || {}, campuriSalvate || {}, ex.suggestedType, b.tip);
  const rec = {
    id: db.nextId('itv'),
    firmaId: fid,
    documentId: doc.id,
    entryId: entry.id,
    at: new Date().toISOString(),
    fileName: doc.fileName || '',
    format: ex.format || extractQuality.formatFisier(doc.fileName),
    source: ex.source || 'necunoscut',
    // CE extractor a citit documentul pe care omul l-a corectat. `source` spune doar „ai" sau
    // „heuristic"; modelul e granularitatea la care se vede daca o schimbare de model a schimbat
    // calitatea. `null` la regulile locale — acolo nu exista model.
    model: ex.model || null,
    provider: ex.provider || null,
    incredere: ex.incredere == null ? null : Number(ex.incredere),
    scor: ex.scor == null ? null : Number(ex.scor),
    decizie: ex.decizie || null,
    controalePicate: ex.controalePicate || [],
    // partenerul SALVAT (cel corect, dupa interventie): raportul trebuie sa arate furnizorul real,
    // nu numele posibil gresit citit de masina
    partener: entry.partener || (ex.fields || {}).partener || '',
    partenerCui: entry.partenerCui || '',
    tipExtras: ex.suggestedType || null,
    tipSalvat: b.tip || null,
    diff,
    corectat: diff.nrModificari > 0,
    motiv: String((b.motivRevizuire == null ? '' : b.motivRevizuire)).slice(0, 300),
  };
  d.extractInterventions = d.extractInterventions || [];
  d.extractInterventions.push(rec);
  doc.interventieId = rec.id;
  return rec;
}

/** Sterge un articol dupa id. `canFid(firmaId)` decide accesul apelantului la firma articolului
 *  (404 identic pentru inexistent in firma si strain); perioada inchisa blocheaza stergerea.
 *  Un id negasit NU e eroare: intoarce removed=0 (contract istoric al rutei). */
function deleteEntry(id, fallbackFid, canFid, actor) {
  const d = db.get();
  const e = d.entries.find((x) => x.id === id);
  if (e && !canFid(e.firmaId == null ? d.firmaActiva : e.firmaId)) fail(404, 'Inregistrare inexistenta.');
  if (e) {
    db.assertPeriodOpen(e.firmaId == null ? fallbackFid : e.firmaId, e.period || periodOf(e.data), 'Stergerea inregistrarii');
    // Jurnal append-only: doar CIORNELE se sterg. Un articol POSTAT (inclusiv cele vechi, fara
    // status) nu se sterge — corectia se face prin STORNO, documentata si reversibila.
    if (entryState(e) === 'postat') fail(400, 'Articol postat — nu se sterge. Corecteaza prin storno (buton ↩ storno).');
    // Miscarea automata a unei ciorne nu a intrat in stocul activ, dar trebuie eliminata odata cu
    // ciorna; altfel ramane orfana si poate reaparea accidental la import/migrare.
    const mids = new Set([...(e.stocMovementIds || []), e.stocMovementId, e.movementId].filter(Boolean));
    if (mids.size) d.stockMovements = (d.stockMovements || []).filter((m) => !mids.has(m.id) && m.entryId !== e.id);
  }
  const n = d.entries.length;
  d.entries = d.entries.filter((x) => x.id !== id);
  if (e) require('./auditOutbox').enqueue(d, 'accounting.entry.delete-draft', e, actor,
    'ciornă ștearsă · ' + String(e.tipNume || e.tip || '') + (e.document ? ' · ' + e.document : ''));
  db.save();
  return { removed: n - d.entries.length, entry: e || null };
}

/** STORNO generic al oricarui articol contabil: creeaza o nota in rosu (aceleasi conturi,
 *  sume negate), legata de original (stornoOf), datata intr-o perioada DESCHISA; marcheaza
 *  originalul `stornat`. Corectie DOCUMENTATA si REVERSIBILA, in locul stergerii distructive.
 *  Articolele cu impact pe stoc au corectia dedicata (stoc/inventar) — aici sunt blocate ca sa
 *  nu desincronizeze fisa de magazie de cartea mare. */
function stornoEntry(id, fallbackFid, canFid, dataStorno, actor) {
  const d = db.get();
  const e = d.entries.find((x) => x.id === id);
  if (!e || !canFid(e.firmaId == null ? d.firmaActiva : e.firmaId)) fail(404, 'Inregistrare inexistenta.');
  if (entryState(e) !== 'postat') fail(400, 'Doar articolele POSTATE se storneaza; o ciorna se sterge direct.');
  if (e.stornoOf) fail(400, 'Nu se storneaza o nota de storno.');
  if (e.stornat) fail(400, 'Inregistrarea e deja stornata (nota ' + e.stornoBy + ').');
  const fid = e.firmaId == null ? fallbackFid : e.firmaId;
  if (actor) {
    permissions.assert(actor, fid, 'entry.post', db.getFirma(fid));
    if (isTreasuryEntry(e)) permissions.assert(actor, fid, 'treasury.approve', db.getFirma(fid));
  }
  const inventarLegat = (d.inventories || []).some((iv) => iv.firmaId === fid && (iv.entryIds || []).includes(e.id));
  if ((e.stocMovementIds && e.stocMovementIds.length) || e.stocMovementId || e.movementId || inventarLegat) {
    fail(400, 'Articolul are miscari de stoc — corecteaza prin stornarea documentului de stoc/inventar (altfel fisa de magazie si cartea mare ar diverge).');
  }
  if (e.tip === 'stat_plata') {
    // Obligatia salariala nu poate fi anulata lasand plata activa: 421 ar deveni creditor negativ.
    // Corectia se desface in ordinea inversa in care a fost construita.
    const platiActive = d.entries.filter((x) => x.firmaId === fid && x.tip === 'plata_salarii'
      && String(x.period || '') === String(e.period || '') && !x.stornat);
    if (platiActive.length) {
      fail(409, 'Statul de plata nu poate fi stornat cat timp plata salariilor este activa (articolul '
        + platiActive.map((x) => x.id).join(', ') + '). Storneaza mai intai plata.');
    }
    // Statele ulterioare pot folosi luna curenta in media CM/CO si in plafoanele anuale. Daca
    // ramaneau active, documentele lor ar continua sa poarte cifre calculate pe o baza anulata.
    const stateUlterioare = d.entries.filter((x) => x.firmaId === fid && x.tip === 'stat_plata'
      && String(x.period || '') > String(e.period || '') && !x.stornat);
    if (stateUlterioare.length) {
      const luni = [...new Set(stateUlterioare.map((x) => x.period))].sort().reverse();
      fail(409, 'Statul de plata pe ' + e.period + ' nu poate fi stornat inaintea statelor ulterioare ('
        + luni.join(', ') + '). Storneaza lunile in ordine inversa.');
    }
  }
  const stornoData = String(dataStorno || new Date().toISOString().slice(0, 10));
  db.assertPeriodOpen(fid, stornoData, 'Stornarea'); // stornul intra intr-o perioada deschisa
  const se = {
    id: db.nextId('e'), firmaId: e.firmaId, data: stornoData, period: stornoData.slice(0, 7),
    tip: 'storno', tipNume: 'Storno ' + (e.tipNume || e.tip), partener: e.partener || '', partenerCui: e.partenerCui || '',
    document: 'Storno ' + (e.document || e.id), analitic: e.analitic || '',
    explicatie: 'Stornare: ' + (e.explicatie || e.tipNume || e.tip), fileId: null, system: true, stornoOf: e.id,
    // STORNO IN ROSU: aceleasi conturi, suma NEGATA. Nu inversarea debit<->credit („in negru"),
    // care lasa soldurile corecte dar UMFLA rulajele: o factura de 10.000 stornata raporta rulaj
    // debit 10.000 SI credit 10.000 pe contul de venit, adica activitate care nu a existat. Cifra
    // de afaceri, baza micro si P&L citesc net (credit-debit) si ieseau bine, dar coloanele de
    // rulaj din balanta si totalul registrului-jurnal mint — si pe ele le citeste contabilul.
    // E si conventia pe care o foloseau deja tipurile `factura_storno_*`; doua conventii pentru
    // aceeasi operatiune in aceeasi aplicatie nu se pot apara. Sumele negative sunt acceptate de
    // validatoarele oficiale (verificat: D406 lunar cu storno in rosu si D300, ambele valide).
    lines: (e.lines || []).map((l) => ({ debit: l.debit, credit: l.credit, suma: round2(-l.suma), explicatie: 'Storno ' + (l.explicatie || '') })),
  };
  const originalArt310 = tvaArt310.classifyEntry(e, new Map((d.entries || []).filter((x) => x && x.id != null)
    .map((x) => [String(x.id), x])));
  if (originalArt310) se.fiscalTaxonomy = { tvaArt310: tvaArt310.snapshot(
    originalArt310.category === 'review_required' ? null : originalArt310.category,
    -Number(originalArt310.amount || 0), 'storno-inherited',
    originalArt310.category === 'review_required' ? { reason: originalArt310.reason } : null) };
  markEntryActor(se, actor, 'postat');
  se.postedBy = actorId(actor); se.postedAt = new Date().toISOString();
  db.pushEntry(se, { context: 'stornare articol', actor });
  e.stornat = true; e.stornoBy = se.id; e.stornoData = stornoData;
  require('./auditOutbox').enqueue(d, 'accounting.entry.storno-link', e, actor,
    'articol ' + e.id + ' legat de nota storno ' + se.id);
  // Fotografia salariala ramane in jurnal pentru audit, dar nu mai alimenteaza registrele,
  // fluturasii, mediile istorice sau D112 dupa stornarea articolului care a produs-o.
  payrollHistory.markStornat(d.payrollHistory, e, se);
  db.save();
  return { storno: se, original: e };
}

/** Tranzitie secventiala in fluxul ciorna -> validat -> aprobat -> postat. POSTAT e
 *  ireversibil (corectia = storno). Postarea verifica
 *  perioada deschisa (o ciorna dintr-o luna intre timp inchisa nu se mai poate posta acolo). */
function setEntryStatus(id, fallbackFid, canFid, target, actor) {
  if (!ENTRY_STATES.includes(target)) fail(400, 'Stare invalida (ciorna/validat/aprobat/postat).');
  const d = db.get();
  const e = d.entries.find((x) => x.id === id);
  if (!e || !canFid(e.firmaId == null ? d.firmaActiva : e.firmaId)) fail(404, 'Inregistrare inexistenta.');
  if (e.stornoOf || e.stornat) fail(400, 'Nota de/din storno — starea nu se schimba.');
  const cur = entryState(e);
  if (cur === 'postat') fail(400, 'Articol deja postat — starea nu se mai schimba. Corectia se face prin storno.');
  if (target === cur) return { entry: e, status: cur }; // idempotent
  const fid = e.firmaId == null ? fallbackFid : e.firmaId;
  const expected = ENTRY_STATES[ENTRY_STATES.indexOf(cur) + 1];
  if (target !== expected) fail(400, 'Tranzitie invalida: din „' + cur + '” urmatorul pas este „' + expected + '”.');
  if (!canTransition(actor, fid, target)) fail(403, 'Rolul tau pe aceasta firma nu permite pasul „' + target + '”.');
  if ((target === 'aprobat' || target === 'postat') && isTreasuryEntry(e)
      && actor && !permissions.can(actor, fid, 'treasury.approve', db.getFirma(fid))) {
    fail(403, 'Aprobarea/postarea unei operatiuni de trezorerie cere dreptul treasury.approve.');
  }
  const aid = actorId(actor);
  if (e.createdBy == null && aid != null) e.createdBy = aid; // ciorne istorice: primul operator devine initiatorul trasabil
  if (makerCheckerRequired(fid) && (target === 'aprobat' || target === 'postat')
      && aid != null && Number(e.createdBy) === aid) {
    fail(409, 'Separarea initiator–aprobator este activa: articolul trebuie aprobat/postat de alta persoana.');
  }
  const at = new Date().toISOString();
  if (target === 'validat') { e.validatedBy = aid; e.validatedAt = at; }
  if (target === 'aprobat') { e.approvedBy = aid; e.approvedAt = at; }
  if (target === 'postat') {
    db.assertPeriodOpen(fid, e.period || periodOf(e.data), 'Postarea'); // nu se posteaza intr-o luna inchisa
    leasingService.assertEntryCanPost(fid, e);
    const view = db.scoped(fid);
    tvaArt310.assertCanPost(view, e, fiscalProfile.profileAt(view, e.data || e.period));
    const mids = new Set(e.stocMovementIds || []);
    if (mids.size) {
      const miscari = (d.stockMovements || []).filter((m) => mids.has(m.id) && m.entryId === e.id);
      if (miscari.length !== mids.size) fail(409, 'Ciorna are legaturi de stoc incomplete; sterge-o si recreeaza documentul.');
      // `db.scoped` exclude deliberat miscarile acestei ciorne, deci baza este stocul activ chiar
      // inaintea postarii. Refolosim aceleasi id-uri: fisa nu capata duplicate.
      const v = db.scoped(fid); let i = 0;
      const r = stocks.saleCogs(v.products, v.stockMovements,
        miscari.map((m) => ({ productId: m.productId, gestiuneId: m.gestiuneId, cantitate: m.cantitate })),
        { fid, data: e.data, document: e.document, entryId: e.id,
          nextId: () => miscari[i++].id, metoda: stocks.metodaFirma(v) });
      if (r.lipsuri.length) {
        fail(409, 'Stoc insuficient la postare: ' + r.lipsuri.map((x) => x.denumire + ' — lipsa ' + x.lipsa).join('; ')
          + '. Inregistreaza receptiile lipsa si reia postarea.');
      }
      const drift = stocks.valuationDrift(v, miscari);
      if (drift) fail(409, 'Postarea retroactiva ar recalcula iesirea deja postata ' + drift.movementId
        + ' (' + drift.data + '). Storneaza si reia documentele de stoc in ordine cronologica.');
      for (const ln of r.cogsLines) {
        if (!coa.getAccount(ln.debit) || !coa.getAccount(ln.credit)) fail(400, 'Cont de descarcare inexistent in plan: ' + ln.debit + '/' + ln.credit);
      }
      const baza = Number.isInteger(e.stocBaseLineCount)
        ? (e.lines || []).slice(0, e.stocBaseLineCount)
        : (e.lines || []).filter((l) => !l.stocAuto && !/^Descărcare gestiune - cost marfă vândută/.test(String(l.explicatie || '')));
      e.stocBaseLineCount = baza.length;
      e.lines = baza.concat(r.cogsLines.map((ln) => Object.assign({}, ln, { stocAuto: true })));
      const valori = new Map(r.newMovements.map((m) => [m.id, m.valoareContabila]));
      for (const m of miscari) m.valoareContabila = round2(Number(valori.get(m.id)) || 0);
    }
    e.postedBy = aid; e.postedAt = at;
  }
  e.status = target;
  e.statusHistory = Array.isArray(e.statusHistory) ? e.statusHistory : [];
  e.statusHistory.push({ status: target, by: aid, username: actorName(actor), at });
  require('./auditOutbox').enqueue(d, 'accounting.entry.status', e, actor,
    'articol ' + e.id + ' → ' + target);
  db.save();
  return { entry: e, status: target };
}

// ── Facturi recurente (sabloane + generare pe perioada) ──

function saveRecurring(fid, b) {
  fid = reqFirma(fid); b = b || {};
  if (!b.tip) fail(400, 'Alege tipul de document.');
  const d = db.get();
  const t = b.id && (d.recurringInvoices || []).find((x) => x.id === b.id && x.firmaId === fid);
  const rec = t || { id: db.nextId('rec'), firmaId: fid, createdAt: new Date().toISOString() };
  Object.assign(rec, {
    tip: String(b.tip), partener: b.partener || '', cuiPartener: b.cuiPartener || '', document: b.document || '',
    fields: (b.fields && typeof b.fields === 'object') ? b.fields : {},
    frecventa: ['lunar', 'trimestrial', 'anual'].includes(b.frecventa) ? b.frecventa : 'lunar',
    ziua: Math.min(28, Math.max(1, Number(b.ziua) || 1)),
    startDate: /^\d{4}-\d{2}$/.test(b.startDate || '') ? b.startDate : new Date().toISOString().slice(0, 7),
    activ: b.activ != null ? !!b.activ : true,
  });
  if (!t) d.recurringInvoices.push(rec);
  db.save();
  return { template: rec };
}

function deleteRecurring(fid, id) {
  fid = reqFirma(fid);
  const d = db.get();
  d.recurringInvoices = (d.recurringInvoices || []).filter((t) => !(t.id === id && t.firmaId === fid));
  db.save();
}

/** Genereaza articolele scadente in perioada din sabloanele active; erorile per sablon se
 *  aduna in `errors` fara sa opreasca restul (contract istoric al rutei). */
function generateRecurring(fid, period, deps) {
  fid = reqFirma(fid);
  const d = db.get();
  period = period || new Date().toISOString().slice(0, 7);
  const due = recurring.dueForPeriod((d.recurringInvoices || []).filter((t) => t.firmaId === fid), period);
  const created = []; const errors = [];
  for (const t of due) {
    const fields = Object.assign({}, t.fields, {
      data: period + '-' + String(t.ziua || 1).padStart(2, '0'),
      partener: t.partener, cuiPartener: t.cuiPartener, document: t.document,
    });
    try {
      const entry = deps.buildEntry(t.tip, fields, null, fid);
      const gViol = fiscalProfile.entryGuard(fiscalProfile.profileAt(db.scoped(fid), entry.data || entry.period), entry);
      if (gViol) throw new Error(gViol); // se aduna in errors, ca orice esec per sablon
      entry.recurringId = t.id;
      entry.dedupeKey = 'recurent:' + t.id + ':' + period;
      if (makerCheckerRequired(fid)) entry.status = 'ciorna';
      markEntryActor(entry, deps && deps.actor, entryState(entry));
      if (entryState(entry) === 'postat') {
        const view = db.scoped(fid);
        tvaArt310.assertCanPost(view, entry, fiscalProfile.profileAt(view, entry.data || entry.period));
      }
      db.pushEntry(entry, { context: 'sablon recurent', actor: deps && deps.actor });
      deps.upsertPartner(fid, entry);
      t.lastGenerated = period;
      created.push({ id: entry.id, tip: entry.tipNume, partener: t.partener });
    } catch (e) { errors.push((t.partener || t.tip) + ': ' + e.message); }
  }
  db.save();
  return { period, created, errors };
}

// ── Blocarea perioadei + TVA la incasare ──

/** Seteaza luna pana la care firma e read-only (null/gol = deblocare completa).
 *  404 (nu 403) pentru firma inexistenta — contractul istoric al rutei de admin. */
function setPeriodLock(fid, lockedUntil, motiv) {
  const firma = db.getFirma(fid);
  if (!firma) fail(404, 'Firma inexistenta.');
  const anterior = firma.lockedUntil || null;
  let urmator;
  if (lockedUntil == null || lockedUntil === '') urmator = null;
  else if (/^\d{4}-\d{2}$/.test(lockedUntil) && Number(lockedUntil.slice(5)) >= 1 && Number(lockedUntil.slice(5)) <= 12) urmator = lockedUntil;
  else fail(400, 'Format invalid. Foloseste YYYY-MM (ex. 2026-05) sau gol pentru deblocare.');
  const override = !!anterior && (!urmator || urmator < anterior);
  const reason = String(motiv || '').trim();
  if (override && reason.length < 10) fail(400, 'Reducerea sau eliminarea blocării este un override și cere un motiv scris (minim 10 caractere).');
  firma.lockedUntil = urmator;
  if (override) {
    firma.periodLockOverrides = Array.isArray(firma.periodLockOverrides) ? firma.periodLockOverrides : [];
    firma.periodLockOverrides.push({ from: anterior, to: urmator, motiv: reason.slice(0, 500), at: new Date().toISOString() });
  }
  db.save();
  return { lockedUntil: firma.lockedUntil, previous: anterior, override, motiv: override ? reason.slice(0, 500) : '' };
}

/** TVA la incasare: din suma bruta incasata/platita, calculeaza TVA exigibila si posteaza nota.
 *  buildEntry e apelat intentionat fara catch (ca in ruta istorica): o eroare de acolo urca
 *  la handlerul global, nu devine 400. */
function tvaExigibilitate(fid, b, deps) {
  fid = reqFirma(fid); b = b || {};
  const brut = round2(Number(b.brut) || 0);
  const cota = Number(b.cota) || 0;
  if (brut <= 0 || cota <= 0) fail(400, 'Completeaza suma bruta si cota TVA.');
  const tva = round2((brut * cota) / (100 + cota));
  const tip = b.tip === 'deductibila' ? 'exigibilitate_tva_deductibila' : 'exigibilitate_tva_colectata';
  const data = b.data && String(b.data).length === 10 ? b.data : new Date().toISOString().slice(0, 10);
  const entry = deps.buildEntry(tip, { data, partener: b.partener || '', document: b.document || '', tva }, null, fid);
  entry.system = true;
  markEntryActor(entry, deps && deps.actor, 'postat');
  entry.postedBy = actorId(deps && deps.actor);
  entry.postedAt = new Date().toISOString();
  const gViol = fiscalProfile.entryGuard(fiscalProfile.profileAt(db.scoped(fid), entry.data || entry.period), entry);
  if (gViol) fail(400, gViol); // neplatitor nu poate exigibiliza TVA colectata
  // baza aferenta TVA-ului devenit exigibil (pentru D300 in perioada exigibilitatii — TVA la incasare)
  entry.tvaExig = { baza: round2(brut - tva), cota, side: b.tip === 'deductibila' ? 'deductibila' : 'colectata' };
  db.pushEntry(entry, { context: 'exigibilitate TVA', actor: deps && deps.actor });
  db.save();
  return { tva, brut, cota, entry };
}

module.exports = {
  createEntry, deleteEntry, stornoEntry, setEntryStatus, isTreasuryEntry,
  saveRecurring, deleteRecurring, generateRecurring,
  setPeriodLock, tvaExigibilitate,
};
