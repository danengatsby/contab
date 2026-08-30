'use strict';

// Ciclul de viata al procesului — scos din server.js: guardul single-instance pe fisierul
// bazei, pornirea ascultarii DUPA hidratarea bazei si oprirea curata la SIGINT/SIGTERM.

const fs = require('fs');
const os = require('os');
const db = require('./db');
const log = require('./log');

// ── Guard single-instance: DOUA procese pe aceeasi baza = pierdere de date (starea traieste
// in RAM, ultima scriere invinge). Lock-ul e cheiat pe FISIERUL de baza (nu pe director), deci
// serverul de test cu baza temporara nu se ciocneste cu instanta live. Toleranta la restartul
// pm2 (suprapunere scurta a proceselor): retry ~2s inainte de a refuza; lock invechit (proces
// mort) -> preluat automat. Rollback: CONTAB_SKIP_LOCK=1.
const LOCK_FILE = db.DB_FILE + '.lock';
// Adresele afisate la pornire. Interfetele publice se listeaza DOAR daca serverul chiar asculta
// pe ele: legat la loopback, un „Retea: http://<ip-public>" ar fi neadevarat — sugereaza un port
// expus care de fapt nu raspunde (endpointul public e nginx). Pur, ca sa poata fi verificat.
function bannerUrls(host, port, ifaces) {
  const out = ['  Local:  http://localhost:' + port];
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return out;
  for (const nume of Object.keys(ifaces || {})) {
    for (const i of (ifaces[nume] || [])) {
      if (i.family === 'IPv4' && !i.internal) out.push('  Retea:  http://' + i.address + ':' + port);
    }
  }
  return out;
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* fara SAB */ } }
function acquireDbLock() {
  if (process.env.CONTAB_SKIP_LOCK === '1') return;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx'); // O_CREAT|O_EXCL — atomic
      fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
      return; // lock obtinut
    } catch (e) {
      if (e.code !== 'EEXIST') { console.error('Nu pot scrie lockfile-ul bazei (' + LOCK_FILE + '): ' + e.message); return; }
      let pid = 0; try { pid = Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim()) || 0; } catch (_) { /* gol */ }
      if (pid && pid !== process.pid && pidAlive(pid)) {
        if (attempt < 19) { sleepMs(100); continue; } // suprapunere de restart — mai asteapta
        console.error('\n⛔ O alta instanta Contabo (PID ' + pid + ') foloseste deja aceeasi baza (' + db.DB_FILE + ').');
        console.error('   Doua procese pe aceeasi baza corup datele. Opreste cealalta instanta sau ruleaza pe alt CONTAB_DB_FILE.');
        console.error('   (bypass, pe propriul risc: CONTAB_SKIP_LOCK=1)\n');
        process.exit(1);
      }
      try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* preluat de altcineva intre timp */ }
    }
  }
}
function releaseDbLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim()) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) { /* ignora */ }
}

/**
 * Poarta de pornire ruleaza INAINTE de hidratarea bazei. `db.load()` trebuie primit ca functie
 * lenesa: pe SQLite, simpla lui evaluare deschide fisierul si poate astepta lock-ul driverului.
 * Daca l-am primi deja evaluat, a doua instanta ar putea ramane blocata in driver inainte sa
 * ajunga la lockfile-ul nostru si exact protectia single-instance n-ar mai putea raspunde.
 */
function prepare(loadDb) {
  // Secretele obligatorii se verifica INAINTE de orice altceva: inaintea lock-ului, a hidratarii
  // si a lui listen(). O instanta care porneste si abia apoi descopera ca semneaza sesiuni cu un
  // secret din baza a apucat deja sa emita cookie-uri forjabile. Vezi src/secretsGuard.js.
  require('./secretsGuard').assertSecrets();
  // Lock-ul este sincron si intentionat PRIMUL pas dupa secrete. Nu asteptam nici citirea Git,
  // nici incarcarea Express: o a doua instanta trebuie refuzata in ~2 secunde chiar daca masina
  // este sub presiune. Daca poarta de deploy pica ulterior, handlerul `exit` elibereaza lock-ul.
  acquireDbLock();
  process.on('exit', releaseDbLock);
  // CE COD PORNESTE. Poarta este in proces, nu in hook-ul npm, deci se aplica identic la
  // `npm start`, `node server.js`, pm2 si systemd. Fara CONTAB_DEV=1, un depozit murdar,
  // o alta ramura sau un `git status` imposibil de citit opresc procesul INAINTE de listen().
  const deployState = require('./deployState');
  const root = require('path').join(__dirname, '..');
  const verificareDeploy = process.env.CONTAB_DEV === '1'
    ? Promise.resolve({ v: null, p: deployState.pornirePermisa(null, { dev: true }) })
    : deployState.read({ force: true }).then((v) => {
      const fsd = require('fs');
      const distributie = fsd.existsSync(require('path').join(root, '.distributie-portabila'))
        || fsd.existsSync(require('path').join(root, '.distributie-windows'));
      const inDepozit = fsd.existsSync(require('path').join(root, '.git'));
      return { v, p: deployState.pornirePermisa(v, { distributie, inDepozit }) };
    });

  return verificareDeploy.then(({ v, p }) => {
    if (!p.ok) {
      const meta = v || {};
      log.error('deploy BLOCAT: ' + p.motiv, {
        ramura: meta.ramura, commit: meta.commit, nrModificate: meta.nrModificate,
      });
      process.exit(1);
    }
    if (v && v.cunoscut) console.log('Cod: ' + v.ramura + '@' + v.commit + ' (arbore curat)');
    return Promise.resolve().then(loadDb);
  });
}

function start({ app, dbReady }) {
  const PORT = process.env.PORT || 8080;
  // Nginx este endpointul public; bind-ul local previne expunerea accidentala a portului Node.
  const HOST = process.env.HOST || '127.0.0.1';
  let server = null; // atribuit dupa hidratarea bazei (dbReady)

  Promise.resolve(dbReady).then(() => {
    server = app.listen(PORT, HOST, () => {
      console.log('Contabo ruleaza (asculta pe ' + HOST + ':' + PORT + ')');
      for (const u of bannerUrls(HOST, PORT, os.networkInterfaces())) console.log(u);
    });
  }).catch((e) => {
    log.error('pornire esuata — baza de date nu s-a putut incarca', { err: e });
    releaseDbLock();
    process.exit(1);
  });

  // Oprire curata (pm2 restart/stop trimite SIGINT): un persist COMPLET, apoi scrie oglinda JSON
  // in asteptare, asteapta coada de scrieri (pg), inchide driverul si opreste ascultarea;
  // plasa de siguranta de 3s daca ceva atarna.
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    // `db.save()` FARA indiciu = diff complet: inchide fereastra deschisa de salvarile partiale
    // (src/persistPlan.js). Fara el, o schimbare nedeclarata de un indiciu gresit ar fi supravietuit
    // doar in oglinda JSON, nu si in baza din care se rehidrateaza la pornire.
    try { db.save(); } catch (_) { /* o oprire nu are voie sa cada pe asta */ }
    try { db.flushMirror(); } catch (_) { /* ignora */ }
    Promise.resolve(db.flushStore()).catch(() => { /* ignora */ }).then(() => {
      if (db.DRIVER === 'sqlite') { try { require('./store').close(); } catch (_) { /* ignora */ } }
      if (db.DRIVER === 'pg') { try { require('./storePg').close(); } catch (_) { /* ignora */ } }
      releaseDbLock();
      if (server) server.close(() => process.exit(0)); else process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { prepare, start, bannerUrls };
