// ─────────────────────────────────────────────────────────────────────────────
//  DECORUL de filmare pentru videoul de prezentare — conturile si firmele fara de care
//  scenele despre ANGAJAREA CONTABILULUI n-ar avea ce arata.
//
//  De ce exista separat de seed: `npm run seed` face firma-exemplu si atat. Filmul cere o
//  situatie cu mai multi actori — un patron cu DOUA firme, un al doilea patron cu firma lui,
//  si un contabil disponibil, angajat de amandoi — fiindcă exact asta spune naratiunea:
//  „un contabil poate fi angajat de mai multi patroni, si poate tine mai multe firme ale
//  aceluiasi patron". O afirmatie care nu se poate arata pe ecran n-are ce cauta in film.
//
//  Se ruleaza DUPA seed si INAINTE de pornirea serverului (scrie direct in baza, ca seed-ul).
//  Idempotent: rulat de doua ori, nu dubleaza nimic.
//
//  Starea in care lasa baza, anume aleasa ca sa se poata filma fiecare scena:
//    - `patron`      — proprietarul firmei-exemplu (cu date pe 2026-06) + o a doua firma
//    - `patron2`     — al doilea patron, cu firma lui
//    - `maria`       — contabil, `disponibilContabil: true`, deci apare in lista
//    - o cerere ACCEPTATA (firma-exemplu)   -> se vede portofoliul contabilului
//    - o cerere ACCEPTATA (firma patronului 2) -> „mai multi patroni"
//    - o cerere IN ASTEPTARE (a doua firma a primului patron) -> se filmeaza ACCEPTAREA pe viu
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const db = require('../src/db');
const auth = require('../src/auth');

const PAROLA = process.env.VIDEO_PW || 'VideoDemo2026x';

// Id-urile urmeaza conventia APLICATIEI, nu `db.nextId('u')`. Prima forma a acestui script folosea
// prefixe text („u2", „f4") si arata perfect la creare — dar `db.getUser` face `Number(id)` si
// `getFirma` la fel, deci cautarile dadeau `undefined`: in tabelul cererilor trimise, coloana
// „Firma" iesea GOALA. Un decor gresit nu pica zgomotos, doar filmeaza altceva decat crezi.
function faUser(d, username, role, profil) {
  let u = d.users.find((x) => x.username === username);
  if (!u) {
    u = { id: db.nextUserId(), username, role, firme: [], firmaActiva: null };
    d.users.push(u);
  }
  const { salt, hash } = auth.hashPassword(PAROLA);
  Object.assign(u, { salt, hash, role, mustChange: false, pending: false, profil: Object.assign({}, u.profil, profil) });
  return u;
}

// `defaultFirma` aduce forma completa a unei firme (profil fiscal, serii, reperul de la care i se
// urmaresc declaratiile). Un obiect scris de mana ar fi parut in regula si ar fi produs restante
// inventate pe lunile dinaintea firmei — vezi `declarations.primaLunaUrmarita`.
function faFirma(d, nume, cui, ownerId) {
  let f = (d.firme || []).find((x) => x.nume === nume);
  if (!f) {
    f = Object.assign(db.defaultFirma(db.nextFirmaId()), { nume, cui, creata: '2026-01-15' });
    d.firme.push(f);
  }
  f.ownerId = ownerId;
  return f;
}

function cerere(d, firmaId, ownerId, contabilId, status) {
  d.serviceRequests = d.serviceRequests || [];
  let r = d.serviceRequests.find((x) => x.firmaId === firmaId && x.contabilId === contabilId);
  if (!r) {
    r = { id: db.nextId('srv'), firmaId, ownerId, contabilId, mesaj: '', ts: '2026-07-02T09:15:00.000Z' };
    d.serviceRequests.push(r);
  }
  r.status = status;
  return r;
}

(async () => {
  await db.ready;
  const d = db.get();

  // firma-exemplu (din seed) devine a patronului, nu a adminului: filmul e despre patron
  const exemplu = (d.firme || []).find((f) => /EXEMPLU PROD/i.test(f.nume || ''));
  if (!exemplu) { console.error('Lipseste firma-exemplu — ruleaza intai `node src/seed.js`.'); process.exit(1); }

  const patron = faUser(d, 'patron', 'user', { numeComplet: 'Andrei Popescu', telefon: '0722 100 200', tipCont: 'patron' });
  const patron2 = faUser(d, 'patron2', 'user', { numeComplet: 'Elena Marin', telefon: '0733 300 400', tipCont: 'patron' });
  const maria = faUser(d, 'maria', 'user', {
    numeComplet: 'Maria Ionescu', telefon: '0745 500 600', tipCont: 'contabil',
    disponibilContabil: true, oras: 'Cluj-Napoca',
    descriere: 'Expert contabil, membru CECCAR. Microîntreprinderi și SRL-uri mici, TVA lunar și trimestrial.',
  });

  exemplu.ownerId = patron.id;
  const aDoua = faFirma(d, 'S.C. EXEMPLU TRANS S.R.L.', 'RO45120988', patron.id);
  const aTreia = faFirma(d, 'S.C. MARIN DESIGN S.R.L.', 'RO39887120', patron2.id);

  // accesul: patronii pe firmele lor, contabila pe cele DOUA deja acceptate
  patron.firme = [exemplu.id, aDoua.id]; patron.firmaActiva = exemplu.id;
  patron2.firme = [aTreia.id]; patron2.firmaActiva = aTreia.id;
  maria.firme = [exemplu.id, aTreia.id]; maria.firmaActiva = exemplu.id;

  cerere(d, exemplu.id, patron.id, maria.id, 'acceptata');   // primul patron, firma cu date
  cerere(d, aTreia.id, patron2.id, maria.id, 'acceptata');   // AL DOILEA patron
  cerere(d, aDoua.id, patron.id, maria.id, 'in_asteptare');  // a DOUA firma a primului patron — se accepta pe camera

  db.save();
  console.log('Decor pregatit:');
  console.log('  patron  (Andrei Popescu) — ' + exemplu.nume + ' + ' + aDoua.nume);
  console.log('  patron2 (Elena Marin)    — ' + aTreia.nume);
  console.log('  maria   (Maria Ionescu)  — contabil disponibil, 2 firme acceptate, 1 cerere in asteptare');
  console.log('  parola tuturor: ' + PAROLA);
  process.exit(0);
})();
