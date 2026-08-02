'use strict';
// Genereaza `date/.env` la prima pornire, pe calculatorul utilizatorului.
//
// FISIER SEPARAT, nu `node -e "…"` in .bat: linia aceea continea ghilimele, bare oblice si
// secvente `\n`, adica exact ce interpreteaza `cmd.exe` inainte sa ajunga la Node. Un fisier .js
// nu are problema asta deloc — si, in plus, se poate citi si corecta de om.
//
// Secretele se genereaza AICI, nu vin in arhiva: altfel toti cei care descarca acelasi pachet ar
// avea aceleasi chei de semnare a sesiunilor si de criptare a datelor.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const radacina = process.cwd();
const dirDate = path.join(radacina, 'date');
const fisier = path.join(dirDate, '.env');

if (fs.existsSync(fisier)) {
  console.log('Configurarea exista deja — nu o suprascriu.');
  process.exit(0);
}

fs.mkdirSync(dirDate, { recursive: true });

// Caile se scriu cu bare NORMALE: `.env` e citit ca text, iar `C:\Users\...` ar fi interpretat
// ca secvente de evadare. Node accepta `/` pe Windows fara nicio problema.
const p = (x) => x.replace(/\\/g, '/');

const continut = [
  '# Generat automat la prima pornire. Nu-l trimite nimanui: contine cheile TALE.',
  'CONTAB_DB_DRIVER=sqlite',
  'CONTAB_DATA_DIR=' + p(dirDate),
  'CONTAB_DB_FILE=' + p(path.join(dirDate, 'db.json')),
  'PORT=8123',
  'HOST=127.0.0.1',
  'CONTAB_AUTH_SECRET=' + crypto.randomBytes(32).toString('hex'),
  'CONTAB_SECRETS_KEY=' + crypto.randomBytes(32).toString('hex'),
  '',
].join('\r\n');

fs.writeFileSync(fisier, continut);
console.log('Configurare creata: date\\.env');
