'use strict';

// Loader intentionat MINIMAL: server.js il ruleaza inainte de lock-ul single-instance si inainte
// sa incarce Express sau restul grafului aplicatiei. Nu suprascrie o variabila deja prezenta in
// mediu (chiar goala), astfel incat operatorul poate dezactiva explicit o valoare din .env.
const fs = require('fs');
const path = require('path');

module.exports = function loadDotEnv(rootDir) {
  try {
    const p = path.join(rootDir || path.join(__dirname, '..'), '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* fisier absent/inaccesibil: validarea configuratiei decide ulterior */ }
};
