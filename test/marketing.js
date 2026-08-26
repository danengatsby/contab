'use strict';

const { stare } = require('./run/comun');
require('./run/marketing')();
console.log('\n' + (stare.fail ? '✗ ' : '✓ ') + stare.pass
  + ' verificari marketing trecute, ' + stare.fail + ' esuate.');
process.exit(stare.fail ? 1 : 0);
