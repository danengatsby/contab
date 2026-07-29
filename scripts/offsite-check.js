'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  VERIFICAREA COPIEI OFFSITE — fara sa astepti cron-ul de la 03:30
//
//  De ce exista: activarea offsite-ului inseamna setarea a cinci-sase variabile, iar singura
//  dovada ca merg era backupul de noapte. Adica: gresesti o litera in secret si afli maine
//  dimineata, din log — daca te uiti. Comanda asta face acelasi drum ca backupul real, dar pe un
//  obiect de proba de cateva zeci de octeti:
//
//    1. criptare openssl + descifrare inapoi, comparand amprenta (exact ce face backup.js)
//    2. PUT catre stocarea obiect, apoi GET inapoi, comparand octetii
//
//  NU atinge arhivele reale si nu trimite niciun e-mail. Obiectul de proba se scrie sub
//  <prefix>/.offsite-check si se suprascrie la fiecare rulare (modulul nu are DELETE, iar a
//  inventa unul doar pentru proba ar fi mai mult cod expus decat un obiect de 40 de octeti).
//
//  Iesire: 0 = totul verificat | 1 = ceva chiar nu merge | 2 = NECONFIGURAT (nu e o reusita)
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

require('../src/bootstrap').loadDotEnv(path.join(__dirname, '..'));
const offsite = require('../src/offsite');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let cod = 0;
const ok = (m) => console.log('  ✓ ' + m);
const nu = (m) => { console.log('  ✗ ' + m); cod = 1; };

async function main() {
  console.log('Verificare offsite (fara sa atinga arhivele reale)\n');

  // ── 1. criptarea ────────────────────────────────────────────────────────────
  const key = process.env.CONTAB_BACKUP_KEY || '';
  console.log('1) Criptare (CONTAB_BACKUP_KEY)');
  if (!key) {
    console.log('  ⚠ CONTAB_BACKUP_KEY ABSENT — copia offsite pleaca NECRIPTATA.');
    console.log('    Genereaza o cheie: openssl rand -base64 48');
    console.log('    Cheia NU se tine langa backup (nu in acelasi bucket, nu in aceeasi cutie postala).');
    cod = Math.max(cod, 2);
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contab-offcheck-'));
    try {
      const clar = path.join(tmp, 'proba.bin');
      const cif = clar + '.enc';
      const inapoi = clar + '.dec';
      const continut = crypto.randomBytes(2048);
      fs.writeFileSync(clar, continut);
      const args = (extra) => ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000'].concat(extra);
      const env = Object.assign({}, process.env, { CONTAB_BACKUP_KEY: key });
      const e = spawnSync('openssl', args(['-in', clar, '-out', cif, '-pass', 'env:CONTAB_BACKUP_KEY']), { env, timeout: 60000 });
      if (e.status !== 0) nu('criptarea a esuat: ' + String(e.stderr || e.error || '').slice(0, 200));
      else {
        ok('criptare AES-256 reusita');
        const cifrat = fs.readFileSync(cif);
        if (cifrat.includes(continut.subarray(0, 32))) nu('textul clar apare in cifrat (?!)');
        else ok('textul clar NU apare in cifrat');
        const d = spawnSync('openssl', args(['-d', '-in', cif, '-out', inapoi, '-pass', 'env:CONTAB_BACKUP_KEY']), { env, timeout: 60000 });
        if (d.status !== 0) nu('descifrarea a esuat — o arhiva care nu se descifreaza e o arhiva pierduta');
        else if (sha(fs.readFileSync(inapoi)) !== sha(continut)) nu('round-trip diferit de original');
        else ok('round-trip identic cu originalul');
        // cheia gresita TREBUIE sa esueze: altfel „criptarea" n-ar proteja nimic
        const rea = spawnSync('openssl', args(['-d', '-in', cif, '-out', path.join(tmp, 'x'), '-pass', 'pass:cheie-gresita']),
          { env, timeout: 60000 });
        if (rea.status === 0) nu('descifrarea cu o cheie GRESITA a reusit (?!)');
        else ok('cheia gresita esueaza, cum trebuie');
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  // ── 2. stocarea obiect ──────────────────────────────────────────────────────
  console.log('\n2) Stocare obiect (CONTAB_OFFSITE_*)');
  const cfg = offsite.fromEnv(process.env);
  if (!offsite.configured(cfg)) {
    const lipsa = ['endpoint', 'bucket', 'accessKey', 'secretKey'].filter((k) => !cfg[k]);
    console.log('  ⚠ NECONFIGURAT — lipsesc: ' + lipsa.join(', '));
    console.log('    CONTAB_OFFSITE_ENDPOINT / _BUCKET / _KEY / _SECRET (+ optional _REGION, _PREFIX)');
    console.log('    Fara ele, singurul transport ramane e-mailul: limitat ca dimensiune si prin terti.');
    cod = Math.max(cod, 2);
  } else {
    const cheie = (cfg.prefix ? cfg.prefix.replace(/\/$/, '') + '/' : '') + '.offsite-check';
    const proba = Buffer.from('contab offsite-check ' + new Date().toISOString());
    try {
      await offsite.putObject(cfg, cheie, proba);
      ok('PUT reusit -> ' + cfg.bucket + '/' + cheie);
      const inapoi = await offsite.getObject(cfg, cheie);
      if (sha(inapoi) !== sha(proba)) nu('obiectul descarcat difera de cel urcat (urcare truncata?)');
      else ok('GET inapoi identic — urcarea chiar ajunge intreaga');
    } catch (e) {
      nu('stocarea obiect nu raspunde: ' + String(e.message).slice(0, 240));
    }
  }

  console.log('');
  if (cod === 0) console.log('VERDE — copia offsite e criptata si stocarea obiect raspunde.');
  else if (cod === 2) console.log('NECONFIGURAT — offsite-ul NU e complet activat. Asta nu e o reusita.');
  else console.log('PICAT — vezi liniile ✗ de mai sus.');
  process.exit(cod);
}

main().catch((e) => { console.error('offsite-check: eroare neasteptata:', e.message); process.exit(1); });
