'use strict';

// Garda sync/async pe driverul de baza: db.get() pe PostgreSQL INAINTE de load() trebuie sa
// ARUNCE (loud), nu sa intoarca date ne-hidratate. Asta face inofensiv "race condition-ul"
// sync (sqlite/json) vs async (pg): un acces gresit — ex. un db.get() la nivel de MODUL, inainte
// ca serverul sa astepte dbReady — cade la pornire (prins si de jobul test-postgres din CI), nu
// tacut in productie. Serverul asculta oricum abia dupa dbReady (src/lifecycle.js), iar cererile
// (singurele care cheama db.get()) ruleaza dupa hidratare.
//
// Ruleaza in proces PROPRIU cu driver pg, ca sa nu atinga suita sqlite; NU are nevoie de un server
// pg real — garda cade inainte de orice conexiune (storePg deschide Pool abia la open()).

process.env.CONTAB_DB_DRIVER = 'pg';
delete process.env.CONTAB_DB_FILE;

let pass = 0; let fail = 0;
const ok = (name, cond) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + name); } };

const db = require('../src/db');

console.log('Garda sync/async pe driverul de baza (pg)');
// contractul async: pe pg, load() e o functie (server.js normalizeaza cu Promise.resolve(db.load()))
ok('pg: db.load e functie (asincron la load)', typeof db.load === 'function');
// garda: get() inainte de load ARUNCA, cu mesaj clar — nu intoarce un obiect ne-hidratat
let threw = null;
try { db.get(); } catch (e) { threw = e; }
ok('pg: db.get() inainte de load() arunca (nu intoarce date ne-hidratate)', threw != null);
ok('pg: mesajul gardei indica hidratarea', threw && /hidratata|hydrated/i.test(threw.message));

console.log((fail ? '✗ ' : '✓ ') + pass + ' verificari garda DB trecute, ' + fail + ' esuate.\n');
process.exit(fail ? 1 : 0);
