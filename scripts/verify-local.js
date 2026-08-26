'use strict';

// Poarta locala de dezvoltare. Ruleaza ambele contracte chiar daca primul pica, ca dezvoltatorul
// sa primeasca intr-o singura incercare verdictul functional si pe cel static. `prestart` NU o
// foloseste: productia poate fi instalata cu --omit=dev, deci ESLint poate lipsi legitim.
const cp = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const checks = [
  { name: 'teste functionale', args: ['test'] },
  { name: 'analiza statica', args: ['run', 'lint'] },
];
const failed = [];
for (const check of checks) {
  process.stdout.write('\n── ' + check.name + '\n');
  const result = cp.spawnSync(npm, check.args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) failed.push(check.name);
}
if (failed.length) {
  process.stderr.write('\nVerificarea locala a picat: ' + failed.join(', ') + '.\n');
  process.exit(1);
}
process.stdout.write('\nVerificarea locala a trecut: teste functionale + analiza statica.\n');
