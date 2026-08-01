'use strict';

// STRATUL DE SERVICII SI INFRASTRUCTURA — autorizarea dublata din `src/*Service.js` (reqFirma /
// reqEntry / reqNotDemo), plus modulele de sustinere: metrici, memo per firma, sesiuni, upload,
// extras bancar, extractor, serializare. Al doilea bloc mutat din `test/run.js`; ca si portile,
// nu imparte fixture-uri cu miezul fiscal — fiecare sectiune isi construieste datele.
//
// Caile relative sunt cu un nivel mai adanci decat in `test/run.js` (`../../src/`), iar radacina
// depozitului vine din `comun.js`. Vezi acolo de ce nu se foloseste `__dirname`.

const { eq, ok, section, RADACINA } = require('./comun');

// Module folosite de sectiunile din acest fisier (erau in antetul lui test/run.js).
const acc = require('../../src/accounting');
const db = require('../../src/db');
const os = require('os');
const path = require('path');

section('Service layer stocuri: autorizarea dublata pe firma (src/stocksService.js)');
const ssvc = require('../../src/stocksService');
const dbx = db.get();
const fidOk = dbx.firme[0].id;
/** ruleaza fn si intoarce statusul erorii de business (sau null daca nu arunca) */
const errStatus = (fn) => { try { fn(); return null; } catch (e) { return e.status || 500; } };
eq('firma inexistenta -> 403', errStatus(() => ssvc.upsertProduct(9999, { cod: 'X', denumire: 'X' })), 403);
eq('firma lipsa (null) -> 403', errStatus(() => ssvc.addMovement(null, 'op', { productId: 'p1', tip: 'receptie', cantitate: 1, data: '2026-01-01' })), 403);
eq('santinela NO_FIRMA (-1) -> 403, fara fallback pe firma activa', errStatus(() => ssvc.upsertGestiune(-1, { cod: 'G', denumire: 'G' })), 403);
const rp = ssvc.upsertProduct(fidOk, { cod: 'SVC-1', denumire: 'Produs service', um: 'buc', cont: '371' });
ok('creare produs prin serviciu (firma valida)', rp.created && rp.product.firmaId === fidOk);
// izolare: aceeasi resursa, ceruta din ALTA firma — serviciul refuza indiferent de apelant
dbx.firme.push({ id: 7777, nume: 'ALT SRL', cui: '77' });
eq('stergerea produsului din alta firma -> 404', errStatus(() => ssvc.deleteProduct(7777, rp.product.id)), 404);
eq('miscare pe produsul altei firme -> 400 (produs inexistent)', errStatus(() => ssvc.addMovement(7777, 'op', { productId: rp.product.id, tip: 'receptie', cantitate: 1, data: '2026-01-01' })), 400);
eq('storno pe inventarul altei firme -> 404', errStatus(() => ssvc.stornoInventory(7777, 'op', 'inv-inexistent', null)), 404);
ssvc.deleteProduct(fidOk, rp.product.id); // produs FARA miscari -> stergere permisa (creat din greseala)
ok('produs fara miscari: stergerea merge', !db.get().products.some((p) => p.id === rp.product.id));
dbx.firme = dbx.firme.filter((f) => f.id !== 7777); // curatenie (doar in memorie)

// ── STERGERE PRODUS vs DEZACTIVARE (fisa de magazie / cartea mare nu diverg) ──
{
  const pu = ssvc.upsertProduct(fidOk, { cod: 'USE-1', denumire: 'Produs folosit', um: 'buc', cont: '371' }).product;
  const gU = ssvc.upsertGestiune(fidOk, { cod: 'GU', denumire: 'Gest U' }).gestiune;
  ssvc.addMovement(fidOk, 'op', { productId: pu.id, tip: 'receptie', cantitate: 3, data: '2026-06-05', pretUnitar: 10, gestiuneId: gU.id });
  eq('produs CU miscari: stergerea e refuzata (400)', errStatus(() => ssvc.deleteProduct(fidOk, pu.id)), 400);
  ok('mesajul indruma spre dezactivare', (() => { try { ssvc.deleteProduct(fidOk, pu.id); return false; } catch (e) { return /[Dd]ezactiveaza/.test(e.message); } })());
  ssvc.setProductActive(fidOk, pu.id, false);
  ok('produsul dezactivat ramane in nomenclator (istoric intact)', db.get().products.some((p) => p.id === pu.id && p.activ === false));
  eq('produs dezactivat: miscare noua refuzata (400)', errStatus(() => ssvc.addMovement(fidOk, 'op', { productId: pu.id, tip: 'receptie', cantitate: 1, data: '2026-06-06', gestiuneId: gU.id })), 400);
  ssvc.setProductActive(fidOk, pu.id, true);
  ok('reactivat: miscarile noi merg din nou', !!ssvc.addMovement(fidOk, 'op', { productId: pu.id, tip: 'receptie', cantitate: 1, data: '2026-06-07', pretUnitar: 10, gestiuneId: gU.id }).movement);
  // curatenie
  db.get().stockMovements = db.get().stockMovements.filter((m) => m.productId !== pu.id);
  db.get().products = db.get().products.filter((p) => p.id !== pu.id);
  db.get().gestiuni = db.get().gestiuni.filter((g) => g.id !== gU.id);
}

// ── COLABORATORI PE FIRMA (contabil <-> necontabil): firmeService ──
section('Colaboratori pe firmă (src/firmeService.js)');
{
  const fsvc = require('../../src/firmeService');
  const dC = db.get();
  const fidC = db.nextFirmaId();
  dC.firme.push({ id: fidC, nume: 'Colab SRL', subscription: { status: 'active', plan: 'grandfathered' } });
  // id-uri manuale unice (db.nextUserId() citeste starea curenta; 3 apeluri inainte de push ar da acelasi id)
  const owner = { id: 90001, username: 'proprietar', role: 'user', firme: [fidC], firmaActiva: fidC };
  const acc = { id: 90002, username: 'contabilx', email: 'c@x.ro', role: 'user', firme: [999], subscription: { status: 'active', plan: 'pro' } };
  const adminU = { id: 90003, username: 'adminx', role: 'admin' };
  dC.users.push(owner, acc, adminU);
  db.save();
  eq('list: initial doar proprietarul', fsvc.listCollaborators(fidC).map((c) => c.username).join(','), 'proprietar');
  // adaugare cont existent (dupa email) -> capata acces
  const added = fsvc.addExistingCollaborator(fidC, { email: 'c@x.ro' });
  eq('addExisting: contabilx capata firma', added.username + ':' + db.get().users.find((u) => u.id === acc.id).firme.includes(fidC), 'contabilx:true');
  eq('addExisting: contabil recunoscut ca tip', added.tip, 'contabil');
  eq('addExisting: dubla -> 400', errStatus(() => fsvc.addExistingCollaborator(fidC, { username: 'contabilx' })), 400);
  eq('addExisting: cont inexistent -> 404', errStatus(() => fsvc.addExistingCollaborator(fidC, { username: 'nimeni' })), 404);
  eq('addExisting: adminul deja are acces -> 400', errStatus(() => fsvc.addExistingCollaborator(fidC, { username: 'adminx' })), 400);
  // invitatie noua -> pending user cu firme:[fidC]
  const inv = fsvc.inviteCollaborator(fidC, { username: 'invitatnou', email: 'i@x.ro' });
  ok('inviteNew: token + pending user cu acces la firma', inv.token.length === 48 && db.get().users.find((u) => u.id === inv.user.id).firme.includes(fidC) && db.get().users.find((u) => u.id === inv.user.id).pending === true);
  eq('inviteNew: username existent -> 400', errStatus(() => fsvc.inviteCollaborator(fidC, { username: 'contabilx' })), 400);
  eq('list: acum 3 (proprietar + contabilx + invitatnou pending)', fsvc.listCollaborators(fidC).length, 3);
  ok('list: invitatia apare cu pending=true', fsvc.listCollaborators(fidC).some((c) => c.username === 'invitatnou' && c.pending));
  // scoatere
  fsvc.removeCollaborator(fidC, acc.id);
  ok('remove: contabilx pierde accesul', !db.get().users.find((u) => u.id === acc.id).firme.includes(fidC));
  eq('remove: non-colaborator -> 404', errStatus(() => fsvc.removeCollaborator(fidC, acc.id)), 404);
  eq('remove: admin -> 404 (nu e colaborator per-firma)', errStatus(() => fsvc.removeCollaborator(fidC, adminU.id)), 404);
  // pana ramane doar proprietarul: scot invitatia, apoi refuz scoaterea ultimului
  fsvc.removeCollaborator(fidC, inv.user.id);
  eq('remove: ultimul utilizator -> 400 (firma nu ramane orfana)', errStatus(() => fsvc.removeCollaborator(fidC, owner.id)), 400);
  // curatenie
  db.get().firme = db.get().firme.filter((f) => f.id !== fidC);
  db.get().users = db.get().users.filter((u) => ![owner.id, acc.id, adminU.id, inv.user.id].includes(u.id));
  db.save();
}

// ── PERIOADA INCHISA: garda unica (db.assertPeriodOpen) uniforma pe serviciile datate ──
{
  const firmaLk = db.getFirma(fidOk);
  const lkPrev = firmaLk.lockedUntil;
  firmaLk.lockedUntil = '2026-03'; // luni <= 2026-03 sunt inchise
  const pLk = ssvc.upsertProduct(fidOk, { cod: 'LK-1', denumire: 'Prod lock', um: 'buc', cont: '371' }).product;
  eq('stoc: miscare in luna INCHISA -> 400', errStatus(() => ssvc.addMovement(fidOk, 'op', { productId: pLk.id, tip: 'receptie', cantitate: 5, data: '2026-02-10', pretUnitar: 10 })), 400);
  ok('mesajul indruma spre storno', (() => { try { ssvc.addMovement(fidOk, 'op', { productId: pLk.id, tip: 'receptie', cantitate: 5, data: '2026-02-10' }); return false; } catch (e) { return /STORNO/i.test(e.message); } })());
  const mvDeschis = ssvc.addMovement(fidOk, 'op', { productId: pLk.id, tip: 'receptie', cantitate: 5, data: '2026-06-10', pretUnitar: 10 }).movement;
  ok('stoc: miscare in luna DESCHISA -> merge', !!mvDeschis.id);
  // stergerea unei miscari dintr-o luna inchisa -> blocata (nu rupe nici nota legata)
  const mvInchis = { id: db.nextId('sm'), firmaId: fidOk, data: '2026-02-15', tip: 'receptie', productId: pLk.id, cantitate: 1, pretUnitar: 1 };
  db.get().stockMovements.push(mvInchis);
  eq('stoc: stergere miscare din luna inchisa -> 400', errStatus(() => ssvc.deleteMovement(fidOk, mvInchis.id)), 400);
  eq('inventar in luna inchisa -> 400', errStatus(() => ssvc.createInventory(fidOk, 'op', { gestiuneId: 'nope', data: '2026-02-01', lines: [] })), 400);
  eq('preluare stoc initial in luna inchisa -> 400', errStatus(() => ssvc.importInitialStock(fidOk, 'op', { data: '2026-02-01', csv: 'cod;den\nX;Y' })), 400);
  // salarii postate intr-o luna inchisa -> blocate
  const psvc = require('../../src/payrollService');
  eq('salarii: postare in luna inchisa -> 400', errStatus(() => psvc.postStatPlata(fidOk, '2026-02', { buildEntry: () => ({ lines: [] }) })), 400);
  // curatenie
  db.get().stockMovements = db.get().stockMovements.filter((m) => m.id !== mvDeschis.id && m.id !== mvInchis.id);
  db.get().products = db.get().products.filter((p) => p.id !== pLk.id);
  firmaLk.lockedUntil = lkPrev;
}

section('Serii de documente prin service layer (docSeries / assignDocNumber)');
eq('seriile firmei inexistente -> 403', errStatus(() => ssvc.docSeries(9999)), 403);
eq('actualizarea seriilor pe firma invalida -> 403', errStatus(() => ssvc.updateDocSeries(null, { NIR: { serie: 'X' } })), 403);
eq('numerotare pe firma invalida -> 403', errStatus(() => ssvc.assignDocNumber(-1, 'NIR', [])), 403);
const serii = ssvc.docSeries(fidOk);
ok('seriile implicite exista (NIR/BC/AVIZ/CH)', serii.NIR && serii.BC && serii.AVIZ && serii.CH);
const mv1 = { id: 'dn1' }; const mv2 = { id: 'dn2' };
const nrStart = serii.NIR.next;
const nr1 = ssvc.assignDocNumber(fidOk, 'NIR', [mv1, mv2]);
ok('numarul e atribuit intregului grup', mv1.docNr.NIR === nr1 && mv2.docNr.NIR === nr1 && nr1.startsWith(serii.NIR.serie + '-'));
eq('seria avanseaza', ssvc.docSeries(fidOk).NIR.next, nrStart + 1);
eq('retiparirea REFOLOSESTE numarul (nu consuma serie)', ssvc.assignDocNumber(fidOk, 'NIR', [mv1, mv2]), nr1);
eq('seria nu a avansat la refolosire', ssvc.docSeries(fidOk).NIR.next, nrStart + 1);

section('Service layer cont (src/accountService.js)');
const asvc = require('../../src/accountService');
const authT = require('../../src/auth');
const totpT = require('../../src/totp');
// garda pe contul demo: refuzata la nivel de serviciu, nu doar in ruta
const demoAcc = { username: 'demo' };
eq('demo: setup 2FA -> 403', errStatus(() => asvc.setup2fa(demoAcc)), 403);
eq('demo: actualizare profil -> 403', errStatus(() => asvc.updateProfile(demoAcc, { email: 'spam@x.ro' })), 403);
eq('demo: revocare dispozitive -> 403', errStatus(() => asvc.revokeTrustedDevices(demoAcc)), 403);
// changePassword nu se mai verifica AICI: e asincron (scrypt pe threadpool — vezi src/auth.js),
// iar suita asta e sincora prin constructie. `errStatus(() => asvc.changePassword(...))` ar primi
// o promisiune RESPINSA, nu o exceptie, si ar raporta verde din motivul gresit — genul de test
// care linisteste fara sa verifice nimic. Cele cinci cazuri (demo -> 403, parola veche gresita,
// parola noua slaba, parola noua = cea veche, schimbarea valida + mustChange stins) se verifica
// pe RUTA, in test/http.js, unde se exercita si legarea prin runA.
const hpT = authT.hashPassword('parola-veche-123');
const u1 = { username: 'tester-cont', salt: hpT.salt, hash: hpT.hash, mustChange: true, sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] };
// fluxul 2FA: setup -> enable (cod real) -> disable, cu gardele de stare
eq('enable fara setup -> 400', errStatus(() => asvc.enable2fa(u1, '123456')), 400);
const s2fa = asvc.setup2fa(u1);
ok('setup: secret + otpauth + QR', !!s2fa.secret && /^otpauth:\/\/totp\//.test(s2fa.otpauth) && /<svg/.test(s2fa.qrSvg));
eq('enable cu cod gresit -> 400', errStatus(() => asvc.enable2fa(u1, '000000')), 400);
const codeNowT = () => totpT.codeForCounter(s2fa.secret, Math.floor(Date.now() / 1000 / 30));
const epoch0 = u1.tfdEpoch || 0;
asvc.enable2fa(u1, codeNowT());
ok('enable: activat, pending consumat, dispozitivele vechi invalidate', u1.twofa === true && !u1.pending2fa && u1.totpSecret === s2fa.secret && u1.tfdEpoch === epoch0 + 1);
eq('setup cu 2FA deja activ -> 400', errStatus(() => asvc.setup2fa(u1)), 400);
eq('disable cu cod gresit -> 400', errStatus(() => asvc.disable2fa(u1, '000000')), 400);
asvc.disable2fa(u1, codeNowT());
ok('disable: dezactivat + secret sters', u1.twofa === false && !u1.totpSecret);
eq('disable cand nu e activ -> 400', errStatus(() => asvc.disable2fa(u1, '000000')), 400);
// sesiuni: listare (curenta marcata, ordinea inversata) + logout-others + revocare
const sess = asvc.listSessions(u1, 's2');
ok('listare: cea mai noua prima + sesiunea curenta marcata', sess[0].id === 's3' && sess[0].current === false && sess.find((s) => s.id === 's2').current === true);
asvc.logoutOtherSessions(u1, 's2');
ok('logout-others pastreaza doar sesiunea curenta', u1.sessions.length === 1 && u1.sessions[0].id === 's2');
asvc.revokeSession(u1, 's2');
eq('revocare individuala: sesiunea dispare', u1.sessions.length, 0);
// profil: campuri albe curatate, cheile necunoscute ignorate, email + notificari
const prof = asvc.updateProfile(u1, { email: 'x@exemplu.ro', notifyDeadlines: false, profil: { numeComplet: '  Ion Pop  ', telefon: '0712', necunoscut: 'ignorat' } });
ok('profil: email + notificari + campuri curatate', prof.email === 'x@exemplu.ro' && prof.notifyDeadlines === false && prof.profil.numeComplet === 'Ion Pop' && prof.profil.necunoscut === undefined);
ok('getProfile reflecta starea', asvc.getProfile(u1).email === 'x@exemplu.ro' && asvc.getProfile(u1).notifyDeadlines === false);

section('Service layer articole contabile (src/entriesService.js)');
const esvc = require('../../src/entriesService');
// buildEntry/upsertPartner sunt infrastructura din server.js (nu se poate require aici — porneste
// serverul); stub-uri minimale, serviciul e testat pe gardele si scrierile proprii
let partnerCalls = 0;
const stubDeps = {
  buildEntry: (tip, f, fileId, fid) => ({
    id: db.nextId('e'), firmaId: fid, data: f.data || '2026-06-15', period: String(f.data || '2026-06-15').slice(0, 7),
    tip, tipNume: 'Stub ' + tip, document: f.document || '', partener: f.partener || '', partenerCui: f.cuiPartener || '',
    explicatie: '', fileId: fileId || null, system: false, lines: [],
  }),
  upsertPartner: () => { partnerCalls += 1; },
};
const throwDeps = { buildEntry: () => { throw new Error('tip invalid'); }, upsertPartner: () => {} };
// gardele de firma (reqFirma refolosit din stocksService)
eq('creare pe firma inexistenta -> 403', errStatus(() => esvc.createEntry(9999, { tip: 'x' }, stubDeps)), 403);
eq('sablon recurent pe firma lipsa -> 403', errStatus(() => esvc.saveRecurring(null, { tip: 'x' })), 403);
eq('generare pe santinela NO_FIRMA -> 403', errStatus(() => esvc.generateRecurring(-1, '2026-06', stubDeps)), 403);
eq('exigibilitate TVA pe firma inexistenta -> 403', errStatus(() => esvc.tvaExigibilitate(9999, { brut: 100, cota: 21 }, stubDeps)), 403);
// creare: eroarea din buildEntry devine 400; succesul scrie si actualizeaza partenerul
eq('buildEntry esueaza -> 400', errStatus(() => esvc.createEntry(fidOk, { tip: 'necunoscut' }, throwDeps)), 400);
const ce = esvc.createEntry(fidOk, { tip: 'test_svc', fields: { data: '2026-06-10', document: 'SVC-E1' } }, stubDeps);
ok('creare: articolul e scris + upsertPartner apelat', db.get().entries.some((e) => e.id === ce.entry.id) && partnerCalls === 1 && ce.stoc === null);
// stergere: 404 fara acces, 400 in perioada inchisa; POSTAT nu se sterge (storno), doar ciornele
eq('stergere fara acces la firma -> 404', errStatus(() => esvc.deleteEntry(ce.entry.id, fidOk, () => false)), 404);
const firmaLockT = db.getFirma(fidOk); const lockPrev = firmaLockT.lockedUntil || null;
firmaLockT.lockedUntil = '2026-06';
eq('stergere in perioada inchisa -> 400', errStatus(() => esvc.deleteEntry(ce.entry.id, fidOk, () => true)), 400);
firmaLockT.lockedUntil = lockPrev;
eq('stergerea unui articol POSTAT -> 400 (corectie prin storno)', errStatus(() => esvc.deleteEntry(ce.entry.id, fidOk, () => true)), 400);
// storno generic: reversare legata + originalul marcat; re-storno refuzat
const stRes = esvc.stornoEntry(ce.entry.id, fidOk, () => true, '2026-06-30');
ok('storno: nota de reversare legata (stornoOf) + original marcat stornat', stRes.storno.stornoOf === ce.entry.id && stRes.original.stornat === true && stRes.storno.system === true);
eq('re-storno al aceluiasi articol -> 400', errStatus(() => esvc.stornoEntry(ce.entry.id, fidOk, () => true)), 400);
// ciorna: se creeaza cu status, NU intra in contabilitate si SE STERGE liber
const dr = esvc.createEntry(fidOk, { tip: 'test_svc', ciorna: true, fields: { data: '2026-06-11', document: 'SVC-DRAFT' } }, stubDeps);
eq('creare cu ciorna:true -> status ciorna', dr.entry.status, 'ciorna');
eq('storno pe o ciorna -> 400 (se sterge direct)', errStatus(() => esvc.stornoEntry(dr.entry.id, fidOk, () => true)), 400);
eq('stergerea unei ciorne: removed=1', esvc.deleteEntry(dr.entry.id, fidOk, () => true).removed, 1);
// flux de stare: ciorna -> validat -> postat; postat = ireversibil
const dr2 = esvc.createEntry(fidOk, { tip: 'test_svc', ciorna: true, fields: { data: '2026-06-11', document: 'SVC-DRAFT2' } }, stubDeps);
eq('avans ciorna->validat', esvc.setEntryStatus(dr2.entry.id, fidOk, () => true, 'validat').status, 'validat');
eq('avans validat->postat', esvc.setEntryStatus(dr2.entry.id, fidOk, () => true, 'postat').status, 'postat');
eq('postat: schimbarea starii -> 400', errStatus(() => esvc.setEntryStatus(dr2.entry.id, fidOk, () => true, 'ciorna')), 400);
eq('stare invalida -> 400', errStatus(() => esvc.setEntryStatus(dr2.entry.id, fidOk, () => true, 'xyz')), 400);
eq('id inexistent NU e eroare: removed=0 (contract istoric)', esvc.deleteEntry('e-inexistent', fidOk, () => true).removed, 0);
// recurente: validare + valori implicite + generare idempotenta pe perioada
eq('sablon fara tip -> 400', errStatus(() => esvc.saveRecurring(fidOk, {})), 400);
const rt = esvc.saveRecurring(fidOk, { tip: 'test_svc', partener: 'Chirias SRL', frecventa: 'gresita', ziua: 99, startDate: '2026-01' }).template;
ok('sablon: frecventa implicita + ziua plafonata la 28', rt.frecventa === 'lunar' && rt.ziua === 28 && rt.activ === true);
const gen1 = esvc.generateRecurring(fidOk, '2026-06', stubDeps);
ok('generare: 1 articol + lastGenerated setat', gen1.created.length === 1 && rt.lastGenerated === '2026-06' && db.get().entries.some((e) => e.recurringId === rt.id));
eq('regenerarea aceleiasi perioade nu dubleaza', esvc.generateRecurring(fidOk, '2026-06', stubDeps).created.length, 0);
const genErr = esvc.generateRecurring(fidOk, '2026-07', throwDeps);
ok('eroarea per sablon se aduna in errors, nu opreste generarea', genErr.created.length === 0 && genErr.errors.length === 1 && /tip invalid/.test(genErr.errors[0]));
esvc.deleteRecurring(fidOk, rt.id);
ok('stergerea sablonului', !(db.get().recurringInvoices || []).some((t) => t.id === rt.id));
db.get().entries = db.get().entries.filter((e) => e.recurringId !== rt.id); // curatenie
// blocarea perioadei: 404 pe firma inexistenta (contract istoric, nu 403), validare format
eq('period-lock pe firma inexistenta -> 404', errStatus(() => esvc.setPeriodLock(9999, '2026-05')), 404);
eq('period-lock cu format invalid -> 400', errStatus(() => esvc.setPeriodLock(fidOk, '05-2026')), 400);
eq('period-lock cu luna invalida -> 400', errStatus(() => esvc.setPeriodLock(fidOk, '2026-13')), 400);
eq('blocare valida', esvc.setPeriodLock(fidOk, '2026-05').lockedUntil, '2026-05');
eq('deblocare cu null', esvc.setPeriodLock(fidOk, null).lockedUntil, null);
// TVA la incasare: validare + calculul sutei marite + baza exigibila
eq('exigibilitate fara suma -> 400', errStatus(() => esvc.tvaExigibilitate(fidOk, { brut: 0, cota: 21 }, stubDeps)), 400);
const tvaR = esvc.tvaExigibilitate(fidOk, { brut: 1210, cota: 21 }, stubDeps);
ok('TVA din suta marita: 1210 la 21% -> 210, baza 1000, nota system', tvaR.tva === 210 && tvaR.entry.tvaExig.baza === 1000 && tvaR.entry.system === true && tvaR.entry.tip === 'exigibilitate_tva_colectata');
db.get().entries = db.get().entries.filter((e) => e.id !== tvaR.entry.id); // curatenie

section('Service layer mesagerie (src/messagesService.js)');
const msvc = require('../../src/messagesService');
const msgsPure = require('../../src/messages');
const dMsg = db.get(); dMsg.messages = dMsg.messages || []; dMsg.users = dMsg.users || [];
dMsg.users.push({ id: 9101, username: 'u-msg' }, { id: 9102, username: 'alt-user' });
const aUserM = { user: { id: 9101, username: 'u-msg' }, isAdmin: false };
const aAltM = { user: { id: 9102, username: 'alt-user' }, isAdmin: false };
const aAdminM = { user: { id: 1, username: 'admin' }, isAdmin: true };
// trimitere: validari + destinatar
eq('mesaj gol fara atasament -> 400', errStatus(() => msvc.sendMessage(aUserM, { text: '  ' }, null)), 400);
eq('mesaj peste MAX_LEN -> 400', errStatus(() => msvc.sendMessage(aUserM, { text: 'x'.repeat(msgsPure.MAX_LEN + 1) }, null)), 400);
eq('adminul fara destinatar valid -> 400', errStatus(() => msvc.sendMessage(aAdminM, { text: 'salut', userId: 424242 }, null)), 400);
// utilizatorul trimite; conversatia arhivata se redeschide automat
dMsg.users.find((x) => x.id === 9101).supportArchived = true;
const sm1 = msvc.sendMessage(aUserM, { text: 'am o intrebare' }, null);
ok('trimitere utilizator: mesaj scris, necitit de admin, conversatia redeschisa', !sm1.fromAdmin && !sm1.message.readByAdmin && dMsg.users.find((x) => x.id === 9101).supportArchived === false);
// adminul deschide firul -> cererile devin citite; utilizator inexistent -> 404
eq('fir pentru utilizator inexistent -> 404', errStatus(() => msvc.threadForAdmin(424242)), 404);
msvc.threadForAdmin(9101);
eq('deschiderea firului marcheaza cererile citite', msgsPure.unreadForAdmin(dMsg.messages), 0);
// raspunsul adminului + inbox-ul utilizatorului il marcheaza citit
const sm2 = msvc.sendMessage(aAdminM, { userId: 9101, text: 'raspuns' }, null);
ok('raspuns admin: fromAdmin + necitit de utilizator', sm2.fromAdmin && !sm2.message.readByUser);
msvc.inbox(aUserM);
eq('inbox-ul utilizatorului marcheaza raspunsurile citite', msgsPure.unreadForUser(dMsg.messages, 9101), 0);
// editare: doar propriile mesaje; golirea e refuzata
eq('utilizatorul editeaza mesajul adminului -> 403', errStatus(() => msvc.editMessage(aUserM, sm2.message.id, 'hack')), 403);
eq('editare mesaj inexistent -> 404', errStatus(() => msvc.editMessage(aAdminM, 'msg-inexistent', 'x')), 404);
eq('golirea unui mesaj fara atasament -> 400', errStatus(() => msvc.editMessage(aAdminM, sm2.message.id, '  ')), 400);
ok('adminul isi editeaza raspunsul', !!msvc.editMessage(aAdminM, sm2.message.id, 'raspuns corectat').message.editedAt);
// atasamente: accesul altui utilizator -> 403, fisier lipsa pe disc -> 404
const smAtt = msvc.sendMessage(aUserM, { text: 'cu fisier' }, { name: 'f.pdf', storedName: 'test-inexistent-9101.pdf', size: 1, mime: 'application/pdf' });
eq('mesaj fara atasament -> 404', errStatus(() => msvc.attachmentFile(aUserM, sm1.message.id)), 404);
eq('atasamentul altui utilizator -> 403', errStatus(() => msvc.attachmentFile(aAltM, smAtt.message.id)), 403);
eq('fisier lipsa pe disc -> 404 (dupa ce accesul a trecut)', errStatus(() => msvc.attachmentFile(aUserM, smAtt.message.id)), 404);
// stergere (admin) + arhivare
eq('stergere mesaj inexistent -> 404', errStatus(() => msvc.deleteMessage('msg-inexistent')), 404);
eq('stergerea cu atasament lipsa pe disc nu crapa (best-effort)', errStatus(() => msvc.deleteMessage(smAtt.message.id)), null);
ok('mesajul a disparut', !dMsg.messages.some((m) => m.id === smAtt.message.id));
eq('arhivare pentru utilizator inexistent -> 404', errStatus(() => msvc.archiveThread(424242, true)), 404);
ok('arhivare + redeschidere', msvc.archiveThread(9101, true).archived === true && msvc.archiveThread(9101, false).archived === false);
// curatenie
dMsg.messages = dMsg.messages.filter((m) => m.userId !== 9101);
dMsg.users = dMsg.users.filter((x) => x.id !== 9101 && x.id !== 9102);

section('Service layer parteneri si solduri initiale (src/partnersService.js)');
const psvc = require('../../src/partnersService');
const coaT = require('../../src/chartOfAccounts');
const fsT = require('fs');
// gardele de firma
eq('partener pe firma inexistenta -> 403', errStatus(() => psvc.upsertPartner(9999, { cui: '123' })), 403);
eq('import parteneri pe firma lipsa -> 403', errStatus(() => psvc.importPartners(null, 'a;b')), 403);
eq('solduri pe santinela NO_FIRMA -> 403', errStatus(() => psvc.setOpening(-1, {})), 403);
// parteneri: normalizarea CUI + pastrarea tipului la actualizare
eq('partener fara CUI -> 400', errStatus(() => psvc.upsertPartner(fidOk, { den: 'X' })), 400);
const ppS = psvc.upsertPartner(fidOk, { cui: 'RO 4242', den: 'Partener SVC', tip: 'client' }).partner;
ok('CUI normalizat (fara RO/spatii)', ppS.cui === '4242' && ppS.tip === 'client');
ok('actualizarea fara tip pastreaza tipul anterior', psvc.upsertPartner(fidOk, { cui: '4242', den: 'Alt nume' }).partner.tip === 'client');
// import CSV: antetul e sarit, randurile fara CUI ajung in erori
eq('CSV parteneri gol -> 400', errStatus(() => psvc.importPartners(fidOk, '')), 400);
const piS = psvc.importPartners(fidOk, 'CUI;Denumire\n111;Firma Unu\n;Fara Cui\nRO222;Firma Doi');
ok('import: 2 importati + 1 eroare de rand + CUI normalizat', piS.importati === 2 && piS.erori.length === 1 && db.get().partners[fidOk]['222'].den === 'Firma Doi');
delete db.get().partners[fidOk]['4242']; delete db.get().partners[fidOk]['111']; delete db.get().partners[fidOk]['222']; // curatenie
// plan de conturi personalizat (global, partajat intre firme)
eq('CSV conturi gol -> 400', errStatus(() => psvc.importAccounts('')), 400);
const aiS = psvc.importAccounts('Cont;Denumire\n8991;Cont test service;8;B');
ok('cont adaugat in plan + customAccounts', aiS.importati === 1 && !!coaT.getAccount('8991') && db.get().customAccounts.some((a) => a.cod === '8991'));
db.get().customAccounts = db.get().customAccounts.filter((a) => a.cod !== '8991'); // curatenie in baza (in planul din memorie ramane pe durata suitei)
// conversia de fisiere: fisierul temporar se sterge si la eroare
const tmpConv = path.join(os.tmpdir(), 'contab-conv-' + process.pid + '.bin');
fsT.writeFileSync(tmpConv, 'nu e un fisier excel');
eq('fisier nerecunoscut -> 400', errStatus(() => psvc.convertUploadToCsv(tmpConv, 'date.xlsx')), 400);
ok('fisierul temporar e sters si la eroare', !fsT.existsSync(tmpConv));
// solduri initiale analitice: upsert pe cheia cont+CUI, stergere dupa index
eq('analitic fara cont -> 400', errStatus(() => psvc.saveOpeningAnalytic(fidOk, { partener: 'X' })), 400);
psvc.saveOpeningAnalytic(fidOk, { cont: '4111', partener: 'Client A', cui: 'RO500', d: 100 });
const oa2 = psvc.saveOpeningAnalytic(fidOk, { cont: '4111', cui: '500', d: 250 });
const oaMine = oa2.openingAnalytic.filter((o) => o.cont === '4111' && String(o.cui).replace(/^RO/i, '') === '500');
ok('acelasi cont+CUI se inlocuieste (nu se dubleaza)', oaMine.length === 1 && oaMine[0].d === 250);
const listOA = db.get().openingAnalytic.filter((o) => (o.firmaId == null ? db.get().firmaActiva : o.firmaId) === fidOk);
psvc.deleteOpeningAnalytic(fidOk, listOA.findIndex((o) => o.cont === '4111' && o.cui === '500'));
ok('stergerea analiticului dupa index', !db.get().openingAnalytic.some((o) => o.firmaId === fidOk && o.cui === '500'));
eq('index invalid NU e eroare (contract istoric)', errStatus(() => psvc.deleteOpeningAnalytic(fidOk, 9999)), null);
// solduri initiale sintetice: dezechilibrul respins cu detaliile in extra
const prevOB = db.get().openingBalances[fidOk];
let obErr = null;
try { psvc.setOpening(fidOk, { 5121: { d: 1000, c: 0 }, 1012: { d: 0, c: 800 } }); } catch (e) { obErr = e; }
ok('dezechilibru -> 400 cu totalurile si diferenta in extra', !!obErr && obErr.status === 400 && obErr.extra && obErr.extra.diferenta === 200 && obErr.extra.totalDebit === 1000 && obErr.extra.totalCredit === 800);
const obOk = psvc.setOpening(fidOk, { 5121: { d: 1000, c: 0 }, 1012: { d: 0, c: 1000 } });
ok('echilibrat: salvat cu totalurile', obOk.totalDebit === 1000 && obOk.totalCredit === 1000);
if (prevOB === undefined) delete db.get().openingBalances[fidOk]; else db.get().openingBalances[fidOk] = prevOB; // restaurare

section('Service layer configurare (src/configService.js)');
const errStatusCfg = (fn) => { try { fn(); return null; } catch (e) { return e.status || 500; } };
const cfsvc = require('../../src/configService');
const fiscalT = require('../../src/fiscal');
// gardele de firma
eq('date firma pe firma inexistenta -> 403', errStatus(() => cfsvc.updateCompany(9999, { nume: 'X' })), 403);
eq('chitanta pe firma lipsa -> 403', errStatus(() => cfsvc.assignChitanta(null, 'e1')), 403);
// datele firmei: ALLOWLIST de profil — campurile de identificare se salveaza, cele
// sensibile (lockedUntil/subscription/anaf) si tehnice (id/logoFile/camp necunoscut) NU
const firmaCfg = db.getFirma(fidOk);
firmaCfg.lockedUntil = '2026-05'; const subInit = firmaCfg.subscription;
cfsvc.updateCompany(fidOk, {
  nume: 'Firma Editata SRL', caen: '6201',                 // profil — permise
  logoFile: 'furat.png', id: 424242, campNecunoscut: 'x',  // tehnice — ignorate
  lockedUntil: null, subscription: { plan: 'gratis-forjat' }, anaf: { clientSecret: 'furat' }, // sensibile — ignorate
});
ok('profil salvat (nume/caen)', firmaCfg.nume === 'Firma Editata SRL' && firmaCfg.caen === '6201');
ok('campurile tehnice ignorate (id/logoFile/necunoscut)', firmaCfg.id === fidOk && firmaCfg.logoFile !== 'furat.png' && firmaCfg.campNecunoscut === undefined);
ok('perioada inchisa NU se poate deschide prin /api/company', firmaCfg.lockedUntil === '2026-05');
ok('abonamentul si credentialele ANAF NU se pot injecta', firmaCfg.subscription === subInit && firmaCfg.anaf === undefined);
delete firmaCfg.lockedUntil; // curatenie
// logo: validare pe magic bytes, nu pe extensie
const tmpLogoBad = path.join(os.tmpdir(), 'contab-logo-bad-' + process.pid + '.png');
fsT.writeFileSync(tmpLogoBad, 'nu e imagine');
eq('fisier care nu e PNG/JPEG -> 400', errStatus(() => cfsvc.setLogo(fidOk, tmpLogoBad)), 400);
ok('fisierul invalid e sters', !fsT.existsSync(tmpLogoBad));
eq('fisier ilizibil -> 400', errStatus(() => cfsvc.setLogo(fidOk, path.join(os.tmpdir(), 'nu-exista-' + process.pid))), 400);
const prevLogo = firmaCfg.logoFile;
const tmpLogoOk = path.join(os.tmpdir(), 'contab-logo-ok-' + process.pid + '.png');
fsT.writeFileSync(tmpLogoOk, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
const logoR = cfsvc.setLogo(fidOk, tmpLogoOk);
ok('PNG valid: logoFile setat pe basename + format detectat', firmaCfg.logoFile === path.basename(tmpLogoOk) && logoR.format === 'PNG');
cfsvc.deleteLogo(fidOk);
ok('stergerea logo-ului goleste campul (fisier lipsa = best-effort)', firmaCfg.logoFile === undefined);
eq('stergerea fara logo NU e eroare (contract istoric)', errStatus(() => cfsvc.deleteLogo(fidOk)), null);
if (prevLogo !== undefined) firmaCfg.logoFile = prevLogo; // restaurare
try { fsT.unlinkSync(tmpLogoOk); } catch (_) { /* posibil mutat/sters */ }
// chitanta: doar incasari in numerar (531x); numarul se atribuie o data si se refoloseste
const dCfg = db.get();
dCfg.entries.push({ id: 'chit-svc-1', firmaId: fidOk, data: '2026-06-01', period: '2026-06', tip: 'incasare_client', tipNume: 'Incasare', partener: 'Casa SRL', document: 'CH-T', lines: [{ debit: '5311', credit: '4111', suma: 150 }] });
dCfg.entries.push({ id: 'chit-svc-2', firmaId: fidOk, data: '2026-06-01', period: '2026-06', tip: 'incasare_client', tipNume: 'Incasare', partener: 'Banca SRL', document: 'CH-B', lines: [{ debit: '5121', credit: '4111', suma: 150 }] });
eq('chitanta pe inregistrare inexistenta -> 404', errStatus(() => cfsvc.assignChitanta(fidOk, 'chit-inexistent')), 404);
eq('chitanta pe incasare prin banca -> 400', errStatus(() => cfsvc.assignChitanta(fidOk, 'chit-svc-2')), 400);
const chNext = ssvc.docSeries(fidOk).CH.next;
const ch1 = cfsvc.assignChitanta(fidOk, 'chit-svc-1');
ok('prima tiparire: numar atribuit din seria CH + suma 531x', ch1.justAssigned && ch1.nr.startsWith(ssvc.docSeries(fidOk).CH.serie + '-') && ch1.suma === 150);
const ch2 = cfsvc.assignChitanta(fidOk, 'chit-svc-1');
ok('retiparirea refoloseste numarul (seria nu avanseaza)', !ch2.justAssigned && ch2.nr === ch1.nr && ssvc.docSeries(fidOk).CH.next === chNext + 1);
dCfg.entries = dCfg.entries.filter((e) => e.id !== 'chit-svc-1' && e.id !== 'chit-svc-2'); // curatenie
// setari globale: ALLOWLIST STRICT (fix escaladare — authSecret/chei arbitrare interzise)
eq('cheia interzisa (authSecret) -> 403, nu se scrie', errStatusCfg(() => cfsvc.updateSettings({ authSecret: 'x' })), 403);
ok('authSecret NU a fost atins', dCfg.settings.authSecret !== 'x');
eq('setare GLOBALA (useAI) fara rol de admin -> 403', errStatusCfg(() => cfsvc.updateSettings({ useAI: false }, false)), 403);
eq('setare GLOBALA (useAI) CU rol de admin -> permisa', (cfsvc.updateSettings({ useAI: false }, true), dCfg.settings.useAI), false);
eq('selfRegister CU rol de admin -> permisa', (cfsvc.updateSettings({ selfRegister: true }, true), dCfg.settings.selfRegister), true);
ok('raspunsul nu contine authSecret (fara leak)', !('authSecret' in cfsvc.updateSettings({ useAI: true }, true).settings));
const prevFiscalCfg = dCfg.settings.fiscal;
const fc1 = cfsvc.setFiscalConfig({ tvaStandard: 19, invalid: 'abc', necunoscut: 5 });
ok('cota valida aplicata imediat, cheile necunoscute ignorate', fc1.current.tvaStandard === 19 && dCfg.settings.fiscal.necunoscut === undefined);
const fc2 = cfsvc.setFiscalConfig({ reset: true });
ok('reset: custom sters + valorile standard revin', fc2.reset && dCfg.settings.fiscal === undefined && fc2.current.tvaStandard === fiscalT.DEFAULTS.tvaStandard);
if (prevFiscalCfg !== undefined) { dCfg.settings.fiscal = prevFiscalCfg; fiscalT.applyConfig(prevFiscalCfg); } // restaurare

section('Service layer inchideri fiscale (src/closingsService.js)');
const clsvc = require('../../src/closingsService');
const firmaCl = db.getFirma(fidOk);
const prevLockCl = firmaCl.lockedUntil || null;
const prevLossCl = firmaCl.pierdereFiscala;
firmaCl.lockedUntil = null;
// gardele de firma si de format
eq('inchidere TVA pe firma inexistenta -> 403', errStatus(() => clsvc.closeVat(9999, '2026-06')), 403);
eq('inchidere TVA pe un AN intreg -> 400 (doar luna)', errStatus(() => clsvc.closeVat(fidOk, '2026')), 400);
eq('inchidere TVA pe luna 13 -> 400', errStatus(() => clsvc.closeVat(fidOk, '2026-13')), 400);
eq('inchidere anuala fara an -> 400', errStatus(() => clsvc.closeYear(fidOk, null)), 400);
eq('impozit pe profit fara an -> 400', errStatus(() => clsvc.closeProfitTax(fidOk, {}, null)), 400);
// blocarea perioadei la inchiderea TVA: se blocheaza si fara TVA de regularizat, doar inainte
const cv1 = clsvc.closeVat(fidOk, '2035-01');
ok('perioada blocata chiar si fara TVA de regularizat', cv1.lockedUntil === '2035-01' && cv1.posted === false);
eq('inchiderea lunii urmatoare avanseaza blocajul', clsvc.closeVat(fidOk, '2035-02').lockedUntil, '2035-02');
eq('inchiderea unei luni mai VECHI nu da blocajul inapoi', clsvc.closeVat(fidOk, '2034-12').lockedUntil, '2035-02');
// inchiderea anuala pe un an fara rulaje: nimic postat
ok('an fara rulaje: posted=false, fara nota', clsvc.closeYear(fidOk, '2035').posted === false && !db.get().entries.some((e) => e.firmaId === fidOk && e.tip === 'inchidere_an' && e.period === '2035-12'));
// optiunile impozitului: pierderea explicita bate pierderea memorata pe firma
firmaCl.pierdereFiscala = { 2034: 500 };
eq('pierderea memorata pe anul precedent se preia implicit', clsvc.profitTaxOptions(fidOk, {}, 2035).pierdereReportata, 500);
eq('pierderea explicita are prioritate', clsvc.profitTaxOptions(fidOk, { pierdereReportata: 100 }, 2035).pierdereReportata, 100);
// impozitul pe profit: dubla inregistrare refuzata; pierderea se memoreaza si la impozit 0
db.get().entries.push({ id: 'cl-svc-dbl', firmaId: fidOk, data: '2036-12-31', period: '2036-12', tip: 'impozit_profit', tipNume: 'Impozit pe profit', lines: [], system: true });
eq('impozitul deja inregistrat pe an -> 400', errStatus(() => clsvc.closeProfitTax(fidOk, {}, '2036')), 400);
db.get().entries = db.get().entries.filter((e) => e.id !== 'cl-svc-dbl');
const cpt = clsvc.closeProfitTax(fidOk, {}, '2035');
ok('an fara profit: posted=false + pierderea de reportat memorata pe firma', cpt.posted === false && firmaCl.pierdereFiscala['2035'] !== undefined);
// repartizarea rezultatului: sold 121 zero -> nimic de repartizat
ok('121 zero: posted=false, fara nota', clsvc.distributeResult(fidOk, '2035').posted === false && !db.get().entries.some((e) => e.firmaId === fidOk && e.tip === 'repartizare_rezultat' && e.period === '2035-12'));
// restaurare
firmaCl.lockedUntil = prevLockCl;
if (prevLossCl === undefined) delete firmaCl.pierdereFiscala; else firmaCl.pierdereFiscala = prevLossCl;

section('Service layer salarizare (src/payrollService.js)');
const paysvc = require('../../src/payrollService');
// firma dedicata, ca testele sa nu depinda de angajatii din seed
db.get().firme.push({ id: 7788, nume: 'PAY SRL', cui: '7788' });
// gardele
eq('angajat pe firma inexistenta -> 403', errStatus(() => paysvc.upsertAngajat(9999, { nume: 'X', salariuBrut: 5000 })), 403);
eq('angajat fara nume/brut -> 400', errStatus(() => paysvc.upsertAngajat(7788, { nume: 'X' })), 400);
eq('stergere angajat inexistent -> 404', errStatus(() => paysvc.deleteAngajat(7788, 'ang-inexistent')), 404);
eq('stat de plata fara angajati -> 400 (inaintea perioadei)', errStatus(() => paysvc.postStatPlata(7788, null, stubDeps)), 400);
// nomenclator: valori implicite igienizate + actualizare pe id
const angR = paysvc.upsertAngajat(7788, { nume: 'Ion Salariat', salariuBrut: 5000, avans: 500, procentCM: 99, sector: 'gresit' }).angajat;
ok('valori implicite: procentCM 75, sector normal, 21 zile lucratoare', angR.procentCM === 75 && angR.sector === 'normal' && angR.zileLucratoare === 21);
const angR2 = paysvc.upsertAngajat(7788, { id: angR.id, nume: 'Ion Salariat', salariuBrut: 6000, avans: 500 }).angajat;
ok('actualizarea pe id pastreaza identitatea', angR2.id === angR.id && angR2.salariuBrut === 6000 && db.get().angajati.filter((a) => a.firmaId === 7788).length === 1);
// postarea statului: perioada obligatorie; liniile de retineri + instantaneul lunar
eq('stat de plata fara perioada -> 400', errStatus(() => paysvc.postStatPlata(7788, null, stubDeps)), 400);
const spR = paysvc.postStatPlata(7788, '2026-06', stubDeps);
ok('avansul intra ca retinere 421=425 in articolul agregat', spR.entry.lines.some((l) => l.debit === '421' && l.credit === '425' && l.suma === 500));
eq('instantaneul lunar e salvat in payrollHistory', db.get().payrollHistory.filter((h) => h.firmaId === 7788 && h.period === '2026-06').length, 1);
paysvc.postStatPlata(7788, '2026-06', stubDeps);
eq('repostarea aceleiasi luni INLOCUIESTE instantaneul (nu dubleaza)', db.get().payrollHistory.filter((h) => h.firmaId === 7788 && h.period === '2026-06').length, 1);
// plata neta: perioada obligatorie, contul necunoscut cade pe banca (5121)
eq('plata fara perioada -> 400', errStatus(() => paysvc.paySalaries(7788, null, '5121', stubDeps)), 400);
const payR = paysvc.paySalaries(7788, '2026-06', 'cont-gresit', stubDeps);
ok('plata: suma = restul de plata, cont implicit 5121', payR.suma > 0 && payR.suma === spR.totals.restPlata && payR.cont === '5121');
eq('plata din casa (5311) e respectata', paysvc.paySalaries(7788, '2026-06', '5311', stubDeps).cont, '5311');
// curatenie: firma de test + tot ce a produs
const dPay = db.get();
dPay.angajati = dPay.angajati.filter((a) => a.firmaId !== 7788);
dPay.entries = dPay.entries.filter((e) => e.firmaId !== 7788);
dPay.payrollHistory = dPay.payrollHistory.filter((h) => h.firmaId !== 7788);
dPay.firme = dPay.firme.filter((f) => f.id !== 7788);

section('Protectie upload: continut pe magic bytes + plafon per utilizator (src/uploadGuard.js)');
const ug = require('../../src/uploadGuard');
ok('pdf real acceptat', ug.contentMatches('.pdf', Buffer.from('%PDF-1.4 continut')));
ok('pdf cu junk inaintea antetului acceptat (spec permite)', ug.contentMatches('.pdf', Buffer.concat([Buffer.alloc(16, 0x41), Buffer.from('%PDF-1.7')])));
ok('pdf deghizat (text/html) respins', !ug.contentMatches('.pdf', Buffer.from('<html>nu e pdf</html>')));
ok('png real acceptat', ug.contentMatches('.png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])));
ok('png deghizat respins', !ug.contentMatches('.png', Buffer.from('GIF89a')));
ok('jpeg real acceptat', ug.contentMatches('.jpg', Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])));
ok('gif real acceptat', ug.contentMatches('.gif', Buffer.from('GIF89a...')));
ok('webp real acceptat', ug.contentMatches('.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])));
ok('fisier gol pe extensie de imagine respins', !ug.contentMatches('.png', Buffer.alloc(0)));
ok('csv text acceptat', ug.contentMatches('.csv', Buffer.from('CUI;Denumire\n1;X')));
ok('csv cu octeti NUL respins (binar deghizat)', !ug.contentMatches('.csv', Buffer.from([0x41, 0x00, 0x42])));
ok('containerele raman pe validarea parserului (.xlsx trece)', ug.contentMatches('.xlsx', Buffer.from('orice-continut')));
// plafonul per utilizator: bucket-uri separate, 429 peste plafon, resetare la igiena
const mkRes = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const limT = ug.userLimit('test-svc', 2, 'Prea multe.');
const reqLim = { user: { id: 424242 } };
let trecute = 0;
for (let i = 0; i < 2; i++) limT(reqLim, mkRes(), () => { trecute += 1; });
eq('sub plafon: cererile trec', trecute, 2);
const rOver = mkRes(); let nextOver = false;
limT(reqLim, rOver, () => { nextOver = true; });
ok('peste plafon: 429 cu mesaj si minutele ramase', !nextOver && rOver.code === 429 && /Reincearca peste ~\d+ min/.test(rOver.body.error));
const rAlt = mkRes(); let nextAlt = false;
limT({ user: { id: 424243 } }, rAlt, () => { nextAlt = true; });
ok('alt utilizator: bucket separat, trece', nextAlt);
ug.pruneRateBuckets(Date.now() + 2 * 3600 * 1000);
const rDupa = mkRes(); let nextDupa = false;
limT(reqLim, rDupa, () => { nextDupa = true; });
ok('dupa igiena (fereastra expirata): plafonul se reseteaza', nextDupa);

section('Calitatea extragerii: controale, decizie, interventii (src/extractQuality.js)');
{
  const eq2 = require('../../src/extractQuality');

  // Vedere de firma: un partener CUNOSCUT (RO111) si un articol deja inregistrat (pentru duplicat).
  const vedere = {
    partners: { RO111: { den: 'ALPHA SRL', cui: 'RO111' } },
    entries: [{ id: 'e1', data: '2026-05-04', document: 'F-900', partener: 'ALPHA SRL', partenerCui: 'RO111', tip: 'factura_cumparare_marfuri' }],
  };
  const BUN = {
    fields: { data: '2026-06-10', document: 'F-123', partener: 'ALPHA SRL', cuiPartener: 'RO111', baza: 1000, tva: 210, cota: 21, suma: 1210 },
    suggestedType: 'factura_cumparare_marfuri', source: 'ai', incredere: 95, fileName: 'factura.pdf',
  };
  const ctxq = { v: vedere, firma: { lockedUntil: '' }, azi: '2026-06-20', standardCota: 21 };
  const ev = (over, ctxOver) => eq2.evalueaza(Object.assign({}, BUN, over || {}), Object.assign({}, ctxq, ctxOver || {}));
  const codc = (r, c) => r.controale.find((x) => x.cod === c);

  // Cazul curat: toate controalele trec -> postare automata permisa
  const bun = ev();
  eq('document curat: toate controalele trec', bun.controale.filter((c) => !c.ok).length, 0);
  eq('document curat: scor 100', bun.scor, 100);
  eq('document curat: decizie auto', bun.decizie, 'auto');
  eq('document curat: fara motive', bun.motive.length, 0);

  // Fiecare control, cazut individual -> revizuire, cu motiv in cuvinte (nu doar un bec rosu)
  const picaCu = (over, ctxOver) => { const r = ev(over, ctxOver); return { r, dec: r.decizie, motive: r.motive.join(' | ') }; };

  const sursa = picaCu({ source: 'heuristic', incredere: null });
  ok('reguli locale -> revizuire (sursa + incredere pica)', sursa.dec === 'revizuire'
    && !codc(sursa.r, 'sursa').ok && !codc(sursa.r, 'incredere').ok && /reguli locale/i.test(sursa.motive));

  const conf = picaCu({ incredere: 60 });
  ok('incredere sub prag -> revizuire, cu pragul scris', conf.dec === 'revizuire' && /60%/.test(conf.motive) && /85%/.test(conf.motive));
  ok('increderea fix pe prag trece', ev({ incredere: eq2.MIN_INCREDERE }).decizie === 'auto');

  const arit = picaCu({ fields: Object.assign({}, BUN.fields, { suma: 1500 }) });
  ok('baza + TVA != total -> revizuire', arit.dec === 'revizuire' && !codc(arit.r, 'aritmetica').ok);

  const cotaGresita = picaCu({ fields: Object.assign({}, BUN.fields, { cota: 9 }) });
  ok('cota nu se potriveste cu raportul TVA/baza -> revizuire', cotaGresita.dec === 'revizuire' && !codc(cotaGresita.r, 'cota').ok);

  ok('data lipsa -> revizuire', !codc(ev({ fields: Object.assign({}, BUN.fields, { data: '' }) }), 'data').ok);
  ok('data in viitor -> revizuire', /viitor/i.test(picaCu({ fields: Object.assign({}, BUN.fields, { data: '2026-12-01' }) }).motive));
  ok('data in perioada INCHISA -> revizuire (ar fi respinsa oricum la postare)',
    /închis/i.test(picaCu({}, { firma: { lockedUntil: '2026-06' } }).motive));

  ok('numar de document lipsa -> revizuire', !codc(ev({ fields: Object.assign({}, BUN.fields, { document: '' }) }), 'document').ok);

  const partenerNou = picaCu({ fields: Object.assign({}, BUN.fields, { partener: 'BETA SRL', cuiPartener: 'RO999' }) });
  ok('partener NOU -> revizuire (primul document al unui furnizor se verifica)',
    partenerNou.dec === 'revizuire' && /nou/i.test(partenerNou.motive));
  ok('partener fara CUI -> revizuire', /nu are CUI/i.test(picaCu({ fields: Object.assign({}, BUN.fields, { cuiPartener: '' }) }).motive));
  ok('CUI cu prefix RO si spatii se potriveste tot cu partenerul cunoscut',
    ev({ fields: Object.assign({}, BUN.fields, { cuiPartener: 'RO 111' }) }).decizie === 'auto');

  const tipNedet = picaCu({ suggestedType: 'nota_contabila' });
  ok('tip nedeterminat (nota contabila = rezerva) -> revizuire', tipNedet.dec === 'revizuire' && /nu a putut fi determinat/i.test(tipNedet.motive));

  const dup = picaCu({ fields: Object.assign({}, BUN.fields, { document: 'F-900' }) });
  ok('document deja inregistrat -> revizuire, cu id-ul articolului existent',
    dup.dec === 'revizuire' && /F-900/.test(dup.motive) && /e1/.test(dup.motive));
  ok('duplicatul se prinde si dupa numele partenerului, fara CUI', (() => {
    const r = eq2.gasesteDuplicat({ entries: vedere.entries }, { document: 'f 900', partener: 'alpha srl' }, 'x');
    return !!r && r.id === 'e1';
  })());
  ok('acelasi numar la ALT partener NU e duplicat',
    !eq2.gasesteDuplicat({ entries: vedere.entries }, { document: 'F-900', partener: 'GAMA SRL', cuiPartener: 'RO7' }, 'x'));

  // Un singur control cazut e de ajuns ca sa opreasca postarea (regula e conjunctie, nu scor)
  const unSingur = ev({ fields: Object.assign({}, BUN.fields, { document: '' }) });
  ok('un singur control cazut opreste postarea, desi scorul ramane mare',
    unSingur.decizie === 'revizuire' && unSingur.scor >= 90);

  // Golurile derivabile se completeaza (nu se suprascrie nimic extras)
  const golTva = ev({ fields: { data: '2026-06-10', document: 'F-7', partener: 'ALPHA SRL', cuiPartener: 'RO111', baza: 1000, suma: 1210 } });
  eq('golul derivabil (TVA) se completeaza din baza si total', golTva.fields.tva, 210);
  eq('...si cota se infereaza din raport', golTva.fields.cota, 21);

  // ── Diferenta om vs masina ──
  const dif = eq2.diferente(
    { data: '2026-06-10', document: 'F-1', partener: 'ALFA', baza: 100, tva: 21, suma: 121 },
    { data: '2026-06-10', document: 'F-1', partener: 'ALPHA SRL', baza: 100, tva: 21, suma: 121 },
    'factura_cumparare_marfuri', 'factura_cumparare_marfuri');
  eq('diferenta prinde exact campul corectat', dif.campuri.map((c) => c.camp).join(','), 'partener');
  eq('...si numara modificarile', dif.nrModificari, 1);
  ok('diferenta pastreaza ambele valori (ce a citit vs ce a salvat)',
    dif.campuri[0].extras === 'ALFA' && dif.campuri[0].salvat === 'ALPHA SRL');
  const difTip = eq2.diferente({ baza: 100 }, { baza: 100 }, 'factura_utilitati', 'factura_servicii_primita');
  ok('schimbarea TIPULUI conteaza ca interventie', difTip.tipSchimbat === true && difTip.nrModificari === 1);
  eq('numerele se compara ca numere, nu ca text', eq2.diferente({ tva: '210' }, { tva: 210 }).nrModificari, 0);
  eq('gol vs lipsa nu e o modificare', eq2.diferente({ document: '' }, {}).nrModificari, 0);
  eq('confirmarea fara schimbari da zero modificari',
    eq2.diferente(BUN.fields, Object.assign({}, BUN.fields), 'x', 'x').nrModificari, 0);

  eq('formatul se ia din extensie', eq2.formatFisier('Factura Alpha.PDF'), 'pdf');
  eq('fara extensie -> necunoscut', eq2.formatFisier('scan'), 'necunoscut');

  // ── Raportul: cine si ce produce erori ──
  const itv = [
    { partener: 'ALPHA SRL', format: 'pdf', source: 'ai', controalePicate: ['partener', 'cota'], diff: { nrModificari: 2, campuri: [{ camp: 'cota' }, { camp: 'partener' }] } },
    { partener: 'ALPHA SRL', format: 'pdf', source: 'ai', controalePicate: ['cota'], diff: { nrModificari: 1, campuri: [{ camp: 'cota' }] } },
    { partener: 'BETA SRL', format: 'jpg', source: 'ai', controalePicate: ['aritmetica'], diff: { nrModificari: 1, campuri: [{ camp: 'suma' }] } },
  ];
  const rp = eq2.raport(itv);
  eq('raport: total interventii', rp.total, 3);
  eq('raport: furnizorul cu cele mai multe corectii e primul', rp.furnizori[0].cheie, 'ALPHA SRL');
  eq('raport: si numarul lor', rp.furnizori[0].interventii, 2);
  eq('raport: controlul dominant al furnizorului', rp.furnizori[0].controaleTop[0].cod, 'cota');
  eq('raport: formatele se grupeaza separat', rp.formate.map((f) => f.cheie + ':' + f.interventii).join(','), 'pdf:2,jpg:1');
  eq('raport: controlul care pica cel mai des', rp.peControl[0].cod, 'cota');
  ok('raport: controlul poarta si numele lizibil', !!rp.peControl[0].nume && rp.peControl[0].nume !== rp.peControl[0].cod);
  eq('raport: campul corectat cel mai des', rp.peCamp[0].camp, 'cota');
  eq('raport gol nu arunca', eq2.raport([]).total, 0);
}

section('Contoarele extragerilor AI (src/metrics.js aiCall/aiSnapshot)');
const metAi = require('../../src/metrics');
metAi.reset();
eq('snapshot gol: zero apeluri', metAi.aiSnapshot().n, 0);
metAi.aiCall(100, true);
metAi.aiCall(300, false, 'timeout la model');
const aiSnap = metAi.aiSnapshot();
ok('agregare: n/fail/avgMs corecte', aiSnap.n === 2 && aiSnap.fail === 1 && aiSnap.avgMs === 200);
ok('ultima eroare e retinuta (mesaj, nu continut)', aiSnap.lastError === 'timeout la model' && !!aiSnap.lastErrorAt);
ok('snapshot() expune sectiunea ai', metAi.snapshot().ai && metAi.snapshot().ai.n === 2);
metAi.reset();
eq('reset goleste si contoarele AI', metAi.aiSnapshot().n, 0);

section('Metrici de performanta pe ruta (src/metrics.js)');
const metricsMod = require('../../src/metrics');
metricsMod.reset();
eq('tipar: id numeric -> :id', metricsMod.routePattern({ url: '/api/firme/123' }), '/api/firme/:id');
eq('tipar: id hex lung -> :id', metricsMod.routePattern({ url: '/api/document/a1b2c3d4e5f6a7b8/file' }), '/api/document/:id/file');
eq('tipar: query-ul se taie', metricsMod.routePattern({ url: '/xml/saft?period=2026-06' }), '/xml/saft');
eq('tipar: ruta Express are prioritate', metricsMod.routePattern({ route: { path: '/api/firme/:id' }, baseUrl: '', url: '/api/firme/9' }), '/api/firme/:id');
metricsMod.record('/xml/saft', 120, 200);
metricsMod.record('/xml/saft', 700, 200);
metricsMod.record('/api/health', 3, 200);
metricsMod.record('/xml/saft', 80, 500);
const snap = metricsMod.snapshot();
eq('agregare: ruta cu cel mai mare timp total e prima', snap.routes[0].route, '/xml/saft');
ok('agregare: n/avg/max corecte', snap.routes[0].n === 3 && snap.routes[0].totalMs === 900 && snap.routes[0].avgMs === 300 && snap.routes[0].maxMs === 700);
ok('agregare: numara lente si 5xx', snap.routes[0].slow === 1 && snap.routes[0].err5xx === 1);
// inelul de erori recente: plafonat, cele mai noi primele
for (let k = 0; k < 25; k++) metricsMod.recordError('eroare ' + k);
const snapE = metricsMod.snapshot();
eq('erori recente: plafonate la 20', snapE.recentErrors.length, 20);
eq('erori recente: cea mai noua prima', snapE.recentErrors[0].msg, 'eroare 24');
eq('erori recente: cele mai vechi au iesit', snapE.recentErrors[19].msg, 'eroare 5');
// starea job-urilor: tick / rezultat / eroare
metricsMod.jobTick('backup');
metricsMod.jobResult('backup', 'db-x.json');
metricsMod.jobError('spv-poll', 'ANAF 503');
const snapJ = metricsMod.snapshot().jobs;
ok('job: tick + rezultat notate', snapJ.backup.lastTickAt && snapJ.backup.lastResult === 'db-x.json' && snapJ.backup.errors === 0);
ok('job: eroarea notata si numarata', snapJ['spv-poll'].lastError === 'ANAF 503' && snapJ['spv-poll'].errors === 1);
metricsMod.reset();
ok('reset: erori si joburi golite', metricsMod.snapshot().recentErrors.length === 0 && Object.keys(metricsMod.snapshot().jobs).length === 0);

section('Ordine cronologica: colator natural refolosit + ultimele N fara sortare completa');
{
  const { naturalCompare } = require('../../src/util');
  // Echivalenta cu localeCompare: spec-ul defineste localeCompare(x, loc, opts) ca
  // Collator(loc, opts).compare(...) — deci un colator refolosit da EXACT aceeasi ordine.
  const probe = ['e2', 'e10', 'e1', 'be100', 'be9', 'e10a', 'E3', 'e03', 'sm7', ''];
  const lc = [...probe].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  const nc = [...probe].sort(naturalCompare);
  eq('colatorul refolosit da aceeasi ordine ca localeCompare', nc.join('|'), lc.join('|'));
  ok('ordine NATURALA, nu lexicografica (e2 inaintea lui e10)', nc.indexOf('e2') < nc.indexOf('e10'));

  // lastEntries(n) == sortEntries(...).slice(-n).reverse(), pe date cu date/id-uri amestecate
  const rnd = [];
  for (let i = 0; i < 400; i++) {
    rnd.push({ id: 'e' + ((i * 37) % 400), data: '2026-' + String(1 + ((i * 7) % 12)).padStart(2, '0') + '-' + String(1 + ((i * 13) % 28)).padStart(2, '0') });
  }
  const idsOf = (arr) => arr.map((e) => e.id).join(',');
  const referinta = (arr, n) => { const s = acc.sortEntries(arr); return s.slice(Math.max(0, s.length - n)).reverse(); };
  for (const n of [0, 1, 5, 399, 400, 500]) {
    eq('lastEntries(' + n + ') identic cu sortEntries().slice(-n).reverse()',
      idsOf(acc.lastEntries(rnd, n)), idsOf(referinta(rnd, n)));
  }
  eq('lastEntries pe lista goala', acc.lastEntries([], 5).length, 0);
  // aceleasi date, ordine de intrare inversata -> acelasi rezultat (nu depinde de ordinea colectiei)
  eq('lastEntries nu depinde de ordinea din colectie', idsOf(acc.lastEntries([...rnd].reverse(), 5)), idsOf(acc.lastEntries(rnd, 5)));
}

section('Memo per firma pentru rutele scumpe (src/cache.js)');
{
  const cache = require('../../src/cache');
  cache.clear();
  let calcule = 0;
  const calc = (marca) => () => { calcule += 1; return { marca, n: calcule }; };
  const revInainte = db.dataRev();
  ok('db expune revizia de scriere (numar)', typeof revInainte === 'number');

  const m1 = cache.memo('t', 1, calc('firma1'));
  ok('prima cerere: miss, se calculeaza', m1.hit === false && m1.value.marca === 'firma1' && calcule === 1);
  const m2 = cache.memo('t', 1, calc('firma1'));
  ok('a doua cerere, fara scriere: hit, NU se recalculeaza', m2.hit === true && calcule === 1);
  ok('hit-ul intoarce exact aceeasi valoare', m2.value === m1.value);

  // izolarea pe firma: cheia include firmaId, deci firma 2 nu vede valoarea firmei 1
  const m3 = cache.memo('t', 2, calc('firma2'));
  ok('alta firma: miss propriu, valoare proprie', m3.hit === false && m3.value.marca === 'firma2');
  ok('firma 1 ramane cachetata separat', cache.memo('t', 1, calc('firma1')).value.marca === 'firma1');
  // ...si nume diferite de raport nu se amesteca intre ele
  ok('alt nume de raport: cheie diferita', cache.memo('altul', 1, calc('alt')).hit === false);

  // INVALIDAREA: orice db.save() avanseaza revizia -> toate memo-urile devin invalide
  const inainte = calcule;
  db.save();
  ok('db.save() avanseaza revizia', db.dataRev() > revInainte);
  const dupaScriere = cache.memo('t', 1, calc('firma1-nou'));
  ok('dupa scriere: miss, se recalculeaza', dupaScriere.hit === false && calcule === inainte + 1);
  ok('valoarea noua o inlocuieste pe cea veche', dupaScriere.value.marca === 'firma1-nou');
  ok('si celelalte firme au fost invalidate', cache.memo('t', 2, calc('firma2')).hit === false);

  // a doua dimensiune de validitate: ZIUA (agregate care depind de „azi", ex. termenul e-Factura)
  {
    const realDate = Date;
    cache.clear(); calcule = 0;
    cache.memo('zi', 1, calc('azi'));
    ok('acelasi moment: hit', cache.memo('zi', 1, calc('azi')).hit === true);
    const maine = new realDate(realDate.now() + 26 * 3600 * 1000);
    global.Date = class extends realDate { constructor(...a) { super(...(a.length ? a : [maine])); } static now() { return maine.getTime(); } };
    const dupaZi = cache.memo('zi', 1, calc('maine'));
    global.Date = realDate;
    ok('a doua zi, fara nicio scriere: miss (agregatele depind de azi)', dupaZi.hit === false);
  }

  // plafon de memorie: LRU, nu crestere nelimitata
  cache.clear();
  for (let i = 0; i < cache.MAX_ENTRIES + 10; i++) cache.memo('lru', i, calc('f' + i));
  ok('plafon LRU respectat', cache.stats().entries === cache.MAX_ENTRIES);

  cache.clear();
  const s0 = cache.stats();
  ok('stats: golit, dar contoarele raman cumulative', s0.entries === 0 && s0.hits > 0 && s0.misses > 0);
  ok('stats: rata de hit intre 0 si 1', s0.hitRate > 0 && s0.hitRate <= 1);
}

section('Service layer firme: autorizarea dublata (src/firmeService.js)');
const fsvc = require('../../src/firmeService');
const fidPrima = dbx.firme[0].id;
// gărzile refuza indiferent de apelant — nu depind de middleware-ul rutei
const demoU = { id: 900, username: 'demo', role: 'user', firme: [fidPrima] };
eq('demo nu creeaza firme -> 403', errStatus(() => fsvc.createFirma(demoU, { nume: 'X' })), 403);
eq('demo nu sterge firme -> 403', errStatus(() => fsvc.deleteFirma(demoU, fidPrima, null)), 403);
const strainU = { id: 901, username: 'strain', role: 'user', firme: [] };
eq('firma straina: editare -> 403', errStatus(() => fsvc.updateFirma(strainU, fidPrima, { nume: 'Hack' })), 403);
eq('firma straina: export JSON -> 403', errStatus(() => fsvc.exportBundle(strainU, fidPrima)), 403);
eq('firma straina: export ZIP -> 403', errStatus(() => fsvc.exportZip(strainU, fidPrima)), 403);
eq('firma straina: activare -> 403', errStatus(() => fsvc.activateFirma(strainU, fidPrima)), 403);
eq('firma straina: clona de test -> 403', errStatus(() => fsvc.testClone(strainU, fidPrima)), 403);
eq('import peste firma la care nu ai acces -> 403', errStatus(() => fsvc.importBundle(strainU, { firma: { nume: 'X' } }, { replace: true, activeFid: fidPrima })), 403);
eq('export toate firmele fara admin -> 403', errStatus(() => fsvc.exportAllZip(strainU)), 403);
// adminul aflat sub impersonare NU are drepturile lui de admin la stergere
const admU = { id: 902, username: 'boss', role: 'admin', firme: [] };
eq('admin sub impersonare: stergere firma straina -> 403', errStatus(() => fsvc.deleteFirma(admU, fidPrima, 55)), 403);
// garda „cel putin o firma ramane" pentru utilizatorul cu o singura firma
const unicU = { id: 903, username: 'unic', role: 'user', firme: [fidPrima], firmaActiva: fidPrima };
eq('stergerea ultimei firme a utilizatorului -> 400', errStatus(() => fsvc.deleteFirma(unicU, fidPrima, null)), 400);

section('Sesiuni & anti-brute-force (src/session.js)');
{
  const sess = require('../../src/session');
  const dbx = require('../../src/db');
  const mkRes = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, append(k, v) { this.headers[k] = this.headers[k] ? [].concat(this.headers[k], v) : v; } });
  const mkReq = (cookie, ip) => ({ headers: { cookie: cookie || '', 'user-agent': 'test-agent' }, ip: ip || '203.0.113.9' });
  const sidOf = (res) => String([].concat(res.headers['Set-Cookie']).find((c) => c.startsWith('sid=')) || '').split(';')[0];

  // utilizator dedicat, curatat la final (baza e temporara oricum)
  const d = dbx.get();
  const su = { id: 7777, username: 'sesiuni-test', role: 'user', firme: [1], firmaActiva: 1, salt: 'x', hash: 'x' };
  d.users.push(su);

  // login -> cookie sid -> currentUser regaseste utilizatorul; sesiunea e inregistrata server-side
  const res1 = mkRes(); const req1 = mkReq();
  sess.startSession(req1, res1, su);
  const sid = sidOf(res1);
  ok('startSession seteaza cookie sid semnat', /^sid=[^;]{20,}$/.test(sid));
  eq('cookie-ul e HttpOnly + SameSite=Lax', /HttpOnly/.test(String(res1.headers['Set-Cookie'])) && /SameSite=Lax/.test(String(res1.headers['Set-Cookie'])), true);
  const found = sess.currentUser(mkReq(sid));
  eq('currentUser din cookie-ul emis', found && found.id, 7777);
  ok('token falsificat -> null', sess.currentUser(mkReq(sid + 'x')) === null);
  // revocarea sesiunii (logout pe alt dispozitiv) invalideaza tokenul inca valid criptografic
  su.sessions = [];
  ok('sesiune revocata server-side -> null (tokenul singur nu ajunge)', sess.currentUser(mkReq(sid)) === null);

  // plafonul de dispozitive: peste MAX_SESSIONS (10), cele mai vechi cad
  for (let i = 0; i < 13; i++) sess.startSession(mkReq(), mkRes(), su);
  eq('sesiunile sunt plafonate la 10 dispozitive', su.sessions.length, 10);

  // dispozitiv de incredere (2FA): valid pentru utilizator, invalidat de schimbarea epocii
  const res2 = mkRes();
  sess.setTrustedDevice(mkReq(), res2, su);
  const tfd = String([].concat(res2.headers['Set-Cookie']).find((c) => String(c).startsWith('tfd='))).split(';')[0];
  ok('setTrustedDevice emite cookie tfd', /^tfd=.{20,}/.test(tfd));
  ok('deviceTrusted recunoaste dispozitivul', sess.deviceTrusted(mkReq(tfd), su) === true);
  su.tfdEpoch = (su.tfdEpoch || 0) + 1; // „deconecteaza celelalte dispozitive"
  ok('schimbarea epocii invalideaza dispozitivele vechi', sess.deviceTrusted(mkReq(tfd), su) === false);
  const alt = { id: 7778 };
  ok('tfd nu e transferabil intre utilizatori', sess.deviceTrusted(mkReq(tfd), alt) === false);

  // anti-brute-force per IP: 8 esecuri -> blocat ~15 min; alt IP nu e afectat; prune curata
  const atkIp = '198.51.100.77';
  eq('atacatorul porneste deblocat', sess.isLocked(mkReq('', atkIp)), 0);
  for (let i = 0; i < 8; i++) sess.bumpFail(mkReq('', atkIp));
  ok('dupa 8 esecuri: blocat (minute ramase > 0)', sess.isLocked(mkReq('', atkIp)) > 0);
  eq('alt IP nu e blocat', sess.isLocked(mkReq('', '198.51.100.78')), 0);
  sess.clearFails(mkReq('', atkIp));
  eq('clearFails deblocheaza (login reusit)', sess.isLocked(mkReq('', atkIp)), 0);
  for (let i = 0; i < 8; i++) sess.bumpFail(mkReq('', atkIp));
  sess.pruneLoginAttempts(Date.now() + 16 * 60 * 1000); // dupa expirarea ferestrei
  eq('pruneLoginAttempts curata blocajele expirate', sess.isLocked(mkReq('', atkIp)), 0);
  eq('attemptKey cade pe x-forwarded-for cand req.ip lipseste', sess.attemptKey({ headers: { 'x-forwarded-for': '192.0.2.5, 10.0.0.1' } }), '192.0.2.5');

  d.users = d.users.filter((x) => x.id !== 7777);
}

section('Extras bancar — parsere CSV / MT940 + sugestii (src/bank.js)');
{
  const bank = require('../../src/bank');
  const csv = 'Data;Descriere;Debit;Credit\n'
    + '03.06.2026;Incasare factura CLIENT ALFA SRL;;1190,00\n'
    + '04.06.2026;Plata furnizor BETA COM;500,50;\n'
    + '05.06.2026;Comision administrare cont;12,00;\n'
    + 'rand fara data valida;x;y;z\n';
  const t = bank.parseCsv(csv);
  eq('CSV: 3 tranzactii valide (randul invalid e sarit)', t.length, 3);
  eq('CSV: data RO dd.mm.yyyy -> ISO', t[0].data, '2026-06-03');
  eq('CSV: creditul e incasare (sens in)', t[0].sens, 'in');
  eq('CSV: suma cu virgula zecimala', t[0].suma, 1190);
  eq('CSV: debitul e plata (sens out)', t[1].sens, 'out');
  // fara antet si cu o singura coloana de suma: semnul da sensul
  const t2 = bank.parseCsv('2026-06-07,POS Kaufland,-89.90\n2026-06-08,Incasare ramburs,25.00\n');
  eq('CSV fara antet: suma negativa -> out', t2[0].sens, 'out');
  eq('CSV fara antet: suma pozitiva -> in', t2[1].sens, 'in');

  const mt = ':61:2606030603C1190,00NTRF\n:86:Incasare CLIENT ALFA SRL factura 101\n:61:2606040604D500,50NTRF\n:86:Plata BETA COM\n';
  const m = bank.parseMt940(mt);
  eq('MT940: 2 tranzactii din :61:', m.length, 2);
  eq('MT940: data din YYMMDD', m[0].data, '2026-06-03');
  eq('MT940: C -> incasare', m[0].sens, 'in');
  eq('MT940: descrierea din :86:', /CLIENT ALFA/.test(m[0].descriere), true);
  eq('parseStatement detecteaza MT940 dupa :61:', bank.parseStatement(mt).length, 2);

  // CAMT.053 (ISO 20022, XML) — extrasul SEPA modern; namespace cu prefix, CRDT/DBIT, stornare, Dt/DtTm
  const camt = '<?xml version="1.0"?><ns:Document xmlns:ns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><ns:BkToCstmrStmt><ns:Stmt>'
    + '<ns:Ntry><ns:Amt Ccy="RON">1190.00</ns:Amt><ns:CdtDbtInd>CRDT</ns:CdtDbtInd><ns:BookgDt><ns:Dt>2026-06-03</ns:Dt></ns:BookgDt>'
    + '<ns:NtryDtls><ns:TxDtls><ns:Amt Ccy="RON">1190.00</ns:Amt><ns:RltdPties><ns:Dbtr><ns:Nm>CLIENT ALFA SRL</ns:Nm></ns:Dbtr></ns:RltdPties><ns:RmtInf><ns:Ustrd>Incasare ALX 1024</ns:Ustrd></ns:RmtInf></ns:TxDtls></ns:NtryDtls></ns:Ntry>'
    + '<ns:Ntry><ns:Amt Ccy="RON">500.50</ns:Amt><ns:CdtDbtInd>DBIT</ns:CdtDbtInd><ns:ValDt><ns:Dt>2026-06-04</ns:Dt></ns:ValDt><ns:NtryDtls><ns:TxDtls><ns:RmtInf><ns:Ustrd>Plata BETA</ns:Ustrd></ns:RmtInf></ns:TxDtls></ns:NtryDtls></ns:Ntry>'
    + '<ns:Ntry><ns:Amt Ccy="RON">30.00</ns:Amt><ns:CdtDbtInd>CRDT</ns:CdtDbtInd><ns:RvslInd>true</ns:RvslInd><ns:BookgDt><ns:DtTm>2026-06-05T09:15:00</ns:DtTm></ns:BookgDt><ns:AddtlNtryInf>Stornare comision</ns:AddtlNtryInf></ns:Ntry>'
    + '</ns:Stmt></ns:BkToCstmrStmt></ns:Document>';
  const camtTx = bank.parseCamt(camt);
  eq('CAMT: 3 tranzactii din <Ntry>', camtTx.length, 3);
  eq('CAMT: CRDT -> incasare (sens in)', camtTx[0].sens, 'in');
  eq('CAMT: suma cu punct zecimal (Amt nivel Ntry, nu TxDtls)', camtTx[0].suma, 1190);
  eq('CAMT: data din BookgDt/Dt', camtTx[0].data, '2026-06-03');
  eq('CAMT: descrierea = remitenta + numele partii', /ALX 1024/.test(camtTx[0].descriere) && /CLIENT ALFA/.test(camtTx[0].descriere), true);
  eq('CAMT: DBIT -> plata (sens out)', camtTx[1].sens, 'out');
  eq('CAMT: cade pe ValDt cand lipseste BookgDt', camtTx[1].data, '2026-06-04');
  eq('CAMT: RvslInd inverseaza semnul (CRDT stornat -> out)', camtTx[2].sens, 'out');
  eq('CAMT: DtTm redus la data (YYYY-MM-DD)', camtTx[2].data, '2026-06-05');
  eq('parseStatement detecteaza CAMT dupa BkToCstmrStmt', bank.parseStatement(camt).length, 3);
  const sugC = bank.parseAndSuggest({ partners: { 12345678: { cui: '12345678', den: 'CLIENT ALFA SRL' } }, entries: [] }, camt);
  eq('CAMT + sugestie: incasarea de la partener cunoscut -> incasare_client potrivit', sugC[0].tip + '|' + sugC[0].matched, 'incasare_client|true');

  // sugestii: comisionul are tip dedicat; partenerul cunoscut e potrivit dupa denumire
  const fakeDb = { partners: { 12345678: { cui: '12345678', den: 'CLIENT ALFA SRL' } }, entries: [] };
  const sug = bank.parseAndSuggest(fakeDb, csv);
  eq('sugestie: incasarea de la partener cunoscut -> incasare_client potrivit', sug[0].tip + '|' + sug[0].matched, 'incasare_client|true');
  eq('sugestie: CUI-ul partenerului potrivit e completat', sug[0].fields.cuiPartener, 'RO12345678');
  eq('sugestie: comisionul bancar are tipul lui', sug[2].tip, 'comision_bancar');
  eq('sugestie: fara facturi deschise -> potrivire "fara"', sug[0].potrivire.tip, 'fara');

  // potrivire cu factura DESCHISA: incasarea de 1190 stinge exact factura clientului (si pre-completeaza doc)
  const dbOpen = {
    partners: { 12345678: { cui: '12345678', den: 'CLIENT ALFA SRL' } },
    entries: [{ id: 'inv1', data: '2026-06-01', document: 'ALX 1024', partener: 'CLIENT ALFA SRL', partenerCui: 'RO12345678',
      lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 190 }] }],
  };
  const sugM = bank.parseAndSuggest(dbOpen, csv);
  eq('potrivire bancara: incasarea de 1190 stinge exact factura deschisa', sugM[0].potrivire.tip, 'exacta');
  eq('potrivire bancara: factura stinsa legata', sugM[0].potrivire.facturi[0].doc, 'ALX 1024');
  eq('potrivire bancara: documentul facturii pre-completat pe potrivirea exacta', sugM[0].fields.document, 'ALX 1024');
  eq('potrivire bancara: legatura de decontare (stinge) propusa spre confirmare', JSON.stringify(sugM[0].stinge), JSON.stringify(['inv1']));
}

section('Extractor — euristici pe text de factura (src/extractor.js)');
{
  const ex = require('../../src/extractor');
  eq('parseRoNumber: 1.234,56 (RO)', ex.parseRoNumber('1.234,56'), 1234.56);
  eq('parseRoNumber: 1,234.56 (EN)', ex.parseRoNumber('1,234.56'), 1234.56);
  eq('parseRoNumber: sufixul lei e ignorat', ex.parseRoNumber('250 lei'), 250);
  eq('parseRoNumber: text gol -> null', ex.parseRoNumber('  '), null);

  const fct = 'FACTURA FISCALA seria ABC nr. 1234 din 05.06.2026\n'
    + 'Furnizor: BETA COM SRL, CUI RO23456789\nCumparator: FIRMA MEA SRL, CUI RO12345678\n'
    + 'Marfuri conform anexa\nTotal fara TVA: 1.000,00\nTotal TVA: 210,00\nTotal de plata: 1.210,00 lei';
  const r = ex.extractFromText(fct, '12345678');
  eq('factura primita: tipul sugerat e cumparare', r.suggestedType, 'factura_cumparare_marfuri');
  eq('extractie: baza dupa eticheta „fara TVA"', r.fields.baza, 1000);
  eq('extractie: TVA reconciliat din total - baza', r.fields.tva, 210);
  eq('extractie: totalul de plata', r.fields.suma, 1210);
  eq('extractie: data documentului', r.fields.data, '2026-06-05');
  ok('extractie: ambele CUI-uri gasite', r.cuis.includes('23456789') && r.cuis.includes('12345678'));
  // sens invers: daca PRIMUL CUI din text e al firmei proprii, e o vanzare
  const out = ex.extractFromText('FACTURA nr 7 din 05.06.2026\nFurnizor: FIRMA MEA SRL CUI RO12345678\nClient: X SRL CUI RO23456789\nPrestari servicii\nTotal de plata: 119,00', '12345678');
  eq('factura emisa (CUI-ul propriu primul): vanzare de servicii', out.suggestedType, 'factura_vanzare_servicii');
  // doar total -> baza si TVA derivate din cota implicita
  const only = ex.extractFromText('FACTURA nr 9 din 05.06.2026\nTotal de plata: 121,00', '');
  eq('doar total: baza derivata din cota standard', only.fields.baza, 100);
  eq('doar total: TVA derivat', only.fields.tva, 21);
}

section('Serializare sigura a bazei (stringifyDb: BigInt / valori nefinite)');
{
  const { stringifyDb } = require('../../src/util');
  // BigInt: nu mai arunca TypeError; sub MAX_SAFE_INTEGER devine numar, peste devine string
  eq('BigInt mic -> numar JSON', stringifyDb({ suma: 42n }), '{"suma":42}');
  eq('BigInt peste MAX_SAFE_INTEGER -> string (fara pierdere de precizie)', stringifyDb({ id: 9007199254740993n }), '{"id":"9007199254740993"}');
  // valorile nefinite pastreaza comportamentul JSON standard (null), dar sunt semnalate in log
  eq('NaN -> null (ca JSON standard)', stringifyDb({ x: NaN }), '{"x":null}');
  eq('Infinity -> null (ca JSON standard)', stringifyDb({ x: Infinity }), '{"x":null}');
  ok('pretty-print cu spatiere functioneaza', /\n {2}"a": 1/.test(stringifyDb({ a: 1 }, 2)));
  // referintele circulare raman erori vizibile (nu au reprezentare corecta)
  const circ = {}; circ.self = circ;
  ok('referinta circulara arunca in continuare', (() => { try { stringifyDb(circ); return false; } catch (e) { return true; } })());

  // scenariul grav de dinainte: un BigInt in graf facea ca TOATE save()-urile sa esueze.
  // Acum save() pe driverul real (sqlite in teste) supravietuieste si persista valoarea convertita.
  const dbx = require('../../src/db');
  const d = dbx.get();
  d.audit = d.audit || [];
  d.audit.push({ id: (d.audit[d.audit.length - 1] || {}).id + 1 || 1, ts: new Date().toISOString(), action: 'test.bigint', detail: '', userId: 1, username: 'x', firmaId: null, durataNs: 12345n });
  let saved = true;
  try { dbx.save(); } catch (e) { saved = false; }
  ok('save() cu BigInt in graf nu mai arunca (persistenta supravietuieste)', saved);
  d.audit = d.audit.filter((a) => a.action !== 'test.bigint');
  dbx.save();
}

section('Garda node:sqlite (driverul implicit cere Node >= 22.13)');
{
  // node:sqlite nu exista pe Node < 22.5 (si e sub flag pana la 22.13): fara garda, driverul
  // IMPLICIT ar cadea cu o eroare criptica la require. checkSqlite transforma caderea intr-un
  // mesaj actionabil, iar package.json declara cerinta (npm avertizeaza la install).
  const storeMod = require('../../src/store');
  ok('pe Node curent, checkSqlite trece (DatabaseSync disponibil)', !!storeMod.checkSqlite(require('node:sqlite')));
  const msg = (() => { try { storeMod.checkSqlite({}, 'v18.19.0'); return ''; } catch (e) { return e.message; } })();
  ok('fara DatabaseSync: mesajul numeste versiunea gasita', /v18\.19\.0/.test(msg));
  ok('mesajul numeste cerinta si flagul istoric', /22\.13/.test(msg) && /--experimental-sqlite/.test(msg));
  ok('mesajul ofera driverele alternative', /CONTAB_DB_DRIVER=pg/.test(msg) && /CONTAB_DB_DRIVER=json/.test(msg));
  const pkg = require('../../package.json');
  ok('package.json declara engines.node >= 22.13', !!(pkg.engines && pkg.engines.node === '>=22.13'));
}

section('Conexiunea locala pg: rolul e EXPLICIT (defect vizibil doar sub cron)');
{
  // Biblioteca `pg` deduce utilizatorul din process.env.USER. Cron ruleaza cu un mediu minimal,
  // FARA USER — acolo pachetul de start pleaca fara rol si serverul raspunde „no PostgreSQL user
  // name specified in startup packet". `psql` (libpq) citeste passwd-ul, deci NU are problema:
  // de-aia drill-ul de restaurare nativa rejuca dump-ul cu succes si abia verificarea de dupa el
  // pica — si numai in productie, sub cron. Orice proba manuala (cu USER setat) il rata.
  const { localPgConfig } = require('../../src/storePg');
  const uSave = process.env.USER; const pgSave = process.env.PGUSER;
  delete process.env.USER; delete process.env.PGUSER;
  const faraMediu = localPgConfig('baza_x');
  process.env.PGUSER = 'rol_explicit';
  const cuPguser = localPgConfig();
  if (uSave === undefined) delete process.env.USER; else process.env.USER = uSave;
  if (pgSave === undefined) delete process.env.PGUSER; else process.env.PGUSER = pgSave;

  ok('rolul e pus chiar fara USER/PGUSER in mediu (sursa: passwd, nu mediul)', !!faraMediu.user);
  eq('baza ceruta explicit e respectata', faraMediu.database, 'baza_x');
  ok('conexiunea ramane pe socketul local (autentificare peer)', /^\//.test(faraMediu.host));
  eq('PGUSER, cand exista, are prioritate', cuPguser.user, 'rol_explicit');

  // Drill-ul nu-si mai rescrie propria conventie de conectare: doua copii chiar au driftat, iar
  // cea din drill ramasese fara `user`. Acum o importa din storePg — sursa unica.
  const drillSrc = require('fs').readFileSync(require('path').join(RADACINA, 'src', 'pgRestoreDrill.js'), 'utf8');
  ok('drill-ul importa conventia din storePg, nu si-o rescrie', /localPgConfig/.test(drillSrc));
  ok('...si nu mai construieste clientul cu host/database scrise de mana',
    !/new Client\(\{\s*host:/.test(drillSrc));
}

section('deployState — ce cod ruleaza de fapt (arbore de lucru = productie)');
{
  const ds = require('../../src/deployState');
  const V = (ramura, porcelain, commit) => ds.verdict(ramura, porcelain, commit);

  const curat = V('main', '', 'abc1234');
  ok('pe main + arbore curat -> curat', curat.curat === true && curat.cunoscut === true);
  eq('fara motiv cand e curat', curat.motiv, null);
  eq('commit-ul e raportat (ce cod ruleaza)', curat.commit, 'abc1234');
  eq('niciun avertisment cand e curat', ds.avertisment(curat), null);

  // Cazul de pe aceasta instalare, chiar acum: fisiere necomise pe o ramura de lucru.
  const murdar = V('aging-si-cost-productie', ' M src/analytic.js\n M src/production.js', 'def5678');
  ok('fisiere necomise -> NU e curat', murdar.curat === false);
  eq('numarul de fisiere e corect', murdar.nrModificate, 2);
  ok('motivul spune AMBELE devieri (ramura si necomisele)',
    /nu pe/.test(murdar.motiv) && /2 fisier/.test(murdar.motiv));
  ok('avertismentul explica MIZA, nu doar starea', /restart/i.test(ds.avertisment(murdar) || ''));
  ok('avertismentul numeste fisierele', /analytic\.js/.test(ds.avertisment(murdar) || ''));

  const altaRamura = V('o-ramura-de-lucru', '', 'aaa1111');
  ok('curat dar pe alta ramura -> tot NU e curat (restartul ar publica alt cod)',
    altaRamura.curat === false && altaRamura.peRamuraDeDeploy === false && altaRamura.nrModificate === 0);

  const doarNecomise = V('main', '?? public/fisier-nou.js', 'bbb2222');
  ok('fisier NETRACAT pe main -> tot murdar (public/ e servit din arbore, deci e deja live)',
    doarNecomise.curat === false && doarNecomise.nrModificate === 1);

  // MIEZUL: fara git nu stim nimic, si asta NU are voie sa semene cu „curat". Aceeasi distinctie
  // ca la drill-ul de restaurare — „nu pot verifica" nu e „e bine". Un deploy dintr-o arhiva
  // (fara .git) ar fi raportat verde de o implementare care confunda cele doua.
  const necunoscut = V('', '', '');
  eq('fara git: cunoscut = false', necunoscut.cunoscut, false);
  eq('fara git: `curat` e null, NU true', necunoscut.curat, null);
  ok('fara git: se spune ca nu s-a putut citi', /nu se poate citi/.test(necunoscut.motiv || ''));
  ok('fara git: avertismentul se aude si el', /nu se poate verifica/.test(ds.avertisment(necunoscut) || ''));

  // Lista se plafoneaza: un arbore foarte murdar nu are voie sa umfle raspunsul /api/metrics.
  const multe = V('main', Array.from({ length: 50 }, (_, i) => ' M f' + i + '.js').join('\n'), 'c');
  eq('numarul real se pastreaza', multe.nrModificate, 50);
  eq('lista se plafoneaza la 20', multe.modificate.length, 20);

  eq('ramura de deploy e `main` (conventia proiectului, nu un knob de mediu)', ds.RAMURA_DEPLOY, 'main');
}

section('Joburi periodice opribile (src/jobs.js: unref + stop)');
{
  // Intervalele joburilor nu au voie sa tina un proces in viata sau sa "scape" dintr-un test:
  // sunt unref() la creare, iar start() intoarce un stop() care le curata pe toate.
  const jobs = require('../../src/jobs');
  const stubs = { doBackup: () => ({ name: 'x' }), resetDemo: () => ({ ok: true }), registerAttempts: new Map(), forgotAttempts: new Map() };
  const h = jobs.start(stubs);
  ok('start() intoarce un handle cu stop()', h && typeof h.stop === 'function');
  eq('stop() curata toate cele 11 joburi', h.stop(), 11);
  eq('stop() e idempotent (a doua oara: nimic de curatat)', jobs.stop(), 0);
  // dupa stop, un nou start functioneaza si se curata la fel (nu ramane stare blocata)
  jobs.start(stubs);
  eq('restart dupa stop: tot 11 joburi, curatate din nou', jobs.stop(), 11);
}

section('Lag-ul buclei de evenimente (metrics.lagValues) — traducerea histogramei');
{
  const m = require('../../src/metrics');
  const H = (count, max, p50, p99) => ({ count, max, percentile: (p) => (p === 50 ? p50 : p99) });
  const NS = (ms) => ms * 1e6;

  // CAPCANA 1 — histograma FARA mostre nu intoarce zerouri, ci gunoi: percentile()=511,
  // min=2^63, mean=NaN. Neprins, /api/metrics ar fi aratat un lag de 9,2e18 ms.
  const gol = m.lagValues({ count: 0, max: 0, percentile: () => 511 }, 30, 0);
  ok('histograma goala -> zerouri, nu valorile-gunoi ale histogramei',
    gol.p50Ms === 0 && gol.p99Ms === 0 && gol.maxMs === 0);
  ok('histograma lipsa (undefined) nu arunca', m.lagValues(undefined, 5, 0).maxMs === 0);

  // CAPCANA 2 — REZOLUTIA E PODEAUA: pe o bucla libera histograma citeste ~10 ms (rezolutia).
  // Raportata ca atare, un server sanatos ar parea permanent intarziat, iar pragul de alerta ar
  // fi masurat de la un reper fals.
  const liber = m.lagValues(H(100, NS(10.1), NS(10.1), NS(11.2)), 60, 0);
  ok('bucla libera raporteaza ~0, nu ~10 (rezolutia e scazuta)', liber.p50Ms <= 0.2 && liber.maxMs <= 0.2);
  eq('rezolutia raportata, ca cifra sa poata fi interpretata', liber.rezolutieMs, 10);

  // Un blocaj real: histograma citeste blocaj + rezolutie, deci se raporteaza blocajul curat.
  const blocat = m.lagValues(H(100, NS(160.2), NS(10.1), NS(160.2)), 60, 0);
  eq('blocaj de 150 ms (citit 160,2 = 150 + rezolutie) -> 150,2', blocat.maxMs, 150.2);
  ok('p50 ramane plat cand doar varful e mare — de aceea alerta se uita la p99/max',
    blocat.p50Ms <= 0.2 && blocat.p99Ms > 100);
  ok('nicio valoare nu iese negativa sub podea', m.lagValues(H(5, NS(3), NS(3), NS(3)), 1, 0).maxMs === 0);

  // lagRoll INCHIDE fereastra: varful de la pornire se pastreaza, fereastra curenta reporneste.
  // Fara asta, `maxMs` al unei histograme necurate n-ar mai scadea niciodata si alerta ar ramane
  // aprinsa pentru un varf de acum trei zile.
  m.reset();
  const dupaReset = m.lagSnapshot();
  eq('reset() duce varful de la pornire la zero', dupaReset.maxTotalMs, 0);
  const r1 = m.lagRoll();
  ok('lagRoll intoarce forma completa', typeof r1.p99Ms === 'number' && typeof r1.fereastraSec === 'number');
  ok('fereastra reporneste dupa roll (fereastraSec revine la ~0)', m.lagSnapshot().fereastraSec <= 1);
  eq('pragul vine din metrics, o singura sursa cu alerta', m.lagSnapshot().pragMs, m.LAG_WARN_MS);

  // Poarta pe INTEGRARE: masura trebuie sa ajunga si in raspunsul rutei, nu doar sa existe.
  ok('snapshot() include campul lag', !!require('../../src/metrics').snapshot().lag);
}

section('Migrari DB versionate (src/migrations.js)');
// backfill idempotent al statutului `activ` pe produse (dezactivarea inlocuieste stergerea)
{
  const dMig = { firme: [{ id: 1 }], products: [{ id: 'x1', cod: 'A' }, { id: 'x2', cod: 'B', activ: false }, { id: 'x3', cod: 'C', activ: true }], partners: {}, openingBalances: {}, settings: {} };
  db.migrate(dMig);
  eq('produs fara camp -> activ:true', dMig.products[0].activ, true);
  eq('produs dezactivat -> ramane false', dMig.products[1].activ, false);
  eq('produs activ -> ramane true (idempotent)', dMig.products[2].activ, true);
}

{
  const mig = require('../../src/migrations');
  const quiet = { info: () => {} }; // fara zgomot in log din testele de migrare
  // baza VECHE (fara schemaVersion): aplica pasii in ordine, stampileaza LATEST
  const dOld = { entries: [{ id: 'e1', data: '2026-03-15' }, { id: 'e2', data: '2026-04-01', period: '2026-04' }] };
  const applied = mig.runMigrations(dOld, { log: quiet });
  eq('baza veche -> schemaVersion stampilat la LATEST', dOld.schemaVersion, mig.LATEST);
  eq('v1 backfill: period derivat din data unde lipsea', dOld.entries[0].period, '2026-03');
  eq('v1 backfill: period existent NU se atinge', dOld.entries[1].period, '2026-04');
  ok('v1 a raportat inregistrarea atinsa', applied.some((a) => a.v === 1 && a.changed === 1));
  // v2: podeaua calendarului fiscal pentru firmele DINAINTE de campul `createdAt`. Fara ea, o
  // firma veche si goala continua sa arate restante pentru luni in care nu exista.
  {
    const dF = { entries: [], firme: [
      { id: 1, subscription: { trialStartedAt: '2026-07-28T09:00:00.000Z' } },
      { id: 2, subscription: { status: 'active', since: '2026-07-05T10:00:00.000Z' } },
      { id: 3, createdAt: '2026-01-01T00:00:00.000Z', subscription: { since: '2026-07-05T10:00:00.000Z' } },
      { id: 4 }, // fara niciun semnal
    ] };
    const ap = mig.runMigrations(dF, { log: quiet });
    eq('v2: reperul preferat e momentul probei', dF.firme[0].createdAt, '2026-07-28T09:00:00.000Z');
    eq('v2: altfel `since`', dF.firme[1].createdAt, '2026-07-05T10:00:00.000Z');
    eq('v2: firma care avea deja createdAt NU se atinge', dF.firme[2].createdAt, '2026-01-01T00:00:00.000Z');
    ok('v2: fara niciun semnal, firma ramane fara reper', dF.firme[3].createdAt === undefined);
    ok('v2 a raportat doua firme completate', ap.some((x) => x.v === 2 && x.changed === 2));
    // idempotent: a doua rulare pe acelasi graf nu mai schimba nimic
    dF.schemaVersion = 0;
    const ap2 = mig.runMigrations(dF, { log: quiet });
    ok('v2 e idempotent (a doua rulare nu mai atinge nimic)', ap2.some((x) => x.v === 2 && x.changed === 0));
  }
  // v4: felul contului dedus din realitate (proprietar de firma = patron), nu ghicit
  {
    const d4 = {
      schemaVersion: 3,
      firme: [{ id: 1, ownerId: 7 }, { id: 2, ownerId: null }],
      users: [
        { id: 7, role: 'user', firme: [1] },          // proprietar -> patron
        { id: 8, role: 'user', firme: [1, 2] },       // doar acces -> contabil
        { id: 9, role: 'user', firme: [], tipCont: 'patron' }, // deja setat -> neatins
        { id: 1, role: 'admin', firme: [] },          // adminul nu intra in clasificare
      ],
    };
    const ap4 = mig.runMigrations(d4, { log: quiet });
    ok('v4 a clasificat doua conturi', ap4.some((x) => x.v === 4 && x.changed === 2));
    eq('proprietarul unei firme e patron', d4.users[0].tipCont, 'patron');
    eq('cine are doar acces e contabil', d4.users[1].tipCont, 'contabil');
    eq('valoarea deja setata nu se suprascrie', d4.users[2].tipCont, 'patron');
    ok('adminul ramane neclasificat', d4.users[3].tipCont === undefined);
    d4.schemaVersion = 3;
    ok('v4 e idempotent', mig.runMigrations(d4, { log: quiet }).some((x) => x.v === 4 && x.changed === 0));
  }
  // re-rulare pe baza deja migrata: idempotent prin VERSIUNE (niciun pas)
  const applied2 = mig.runMigrations(dOld, { log: quiet });
  eq('re-rulare: niciun pas aplicat', applied2.length, 0);
  // baza deja la LATEST: pasii <= schemaVersion nu ruleaza
  const dNew = { entries: [{ id: 'x', data: '2026-01-01' }], schemaVersion: mig.LATEST };
  mig.runMigrations(dNew, { log: quiet });
  ok('baza la zi: backfill nu ruleaza (period ramane absent)', dNew.entries[0].period === undefined);
  // forward-only: o baza mai noua decat codul NU se coboara
  const dFuture = { entries: [], schemaVersion: mig.LATEST + 5 };
  mig.runMigrations(dFuture, { log: quiet });
  eq('forward-only: versiunea mai noua nu se coboara', dFuture.schemaVersion, mig.LATEST + 5);
  // versiuni strict crescatoare, fara duplicate (contract pentru autorii de pasi)
  const vs = mig.MIGRATIONS.map((m) => m.v);
  ok('versiunile migrarilor sunt strict crescatoare', vs.every((v, i) => i === 0 || v > vs[i - 1]));
  // integrare: baza reala incarcata de db.js a primit schemaVersion prin hook-ul din migrate()
  eq('db incarcata: schemaVersion = LATEST (hook in migrate)', require('../../src/db').get().schemaVersion, mig.LATEST);
}

