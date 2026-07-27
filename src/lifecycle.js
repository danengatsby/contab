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

function start({ app, dbReady }) {
  // Secretele obligatorii se verifica INAINTE de orice altceva: inaintea lock-ului, a hidratarii
  // si a lui listen(). O instanta care porneste si abia apoi descopera ca semneaza sesiuni cu un
  // secret din baza a apucat deja sa emita cookie-uri forjabile. Vezi src/secretsGuard.js.
  require('./secretsGuard').assertSecrets();
  acquireDbLock();
  process.on('exit', releaseDbLock);

  const PORT = process.env.PORT || 8080;
  // Nginx este endpointul public; bind-ul local previne expunerea accidentala a portului Node.
  const HOST = process.env.HOST || '127.0.0.1';
  let server = null; // atribuit dupa hidratarea bazei (dbReady)
  dbReady.then(() => {
    server = app.listen(PORT, HOST, () => {
      console.log('Contabo ruleaza (asculta pe ' + HOST + ':' + PORT + ')');
      for (const u of bannerUrls(HOST, PORT, os.networkInterfaces())) console.log(u);
    });
  }).catch((e) => {
    log.error('pornire esuata — baza de date nu s-a putut incarca', { err: e });
    releaseDbLock();
    process.exit(1);
  });

  // Oprire curata (pm2 restart/stop trimite SIGINT): scrie oglinda JSON in asteptare,
  // asteapta coada de scrieri (pg), inchide driverul si opreste ascultarea;
  // plasa de siguranta de 3s daca ceva atarna.
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
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

module.exports = { start, bannerUrls };
