'use strict';

// Verifica sintaxa tuturor fisierelor .js (node --check). Folosit in `npm run lint` si CI.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SKIP = new Set(['node_modules', 'data', '.git', 'logs']);
const files = [];
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { if (!SKIP.has(f)) walk(p); }
    else if (f.endsWith('.js')) files.push(p);
  }
}
['src', 'scripts', 'test', 'public'].forEach((d) => { if (fs.existsSync(d)) walk(d); });
if (fs.existsSync('server.js')) files.push('server.js');

// Fisierele frontend cu import/export sunt module ES (public/*.js incarcate cu
// <script type="module">). package.json e "commonjs", deci `node --check <fisier>` le-ar
// respinge — le validam ca module, prin stdin cu --input-type=module.
const isEsm = (src) => /^\s*(import|export)\s/m.test(src);
let bad = 0;
for (const f of files) {
  try {
    const src = fs.readFileSync(f, 'utf8');
    if (isEsm(src)) cp.execSync('node --check --input-type=module', { input: src, stdio: ['pipe', 'pipe', 'pipe'] });
    else cp.execSync('node --check ' + JSON.stringify(f), { stdio: 'pipe' });
  } catch (e) { bad += 1; console.error('  ✗ ' + f + ': ' + String(e.stderr || e.message).split('\n')[0]); }
}
console.log((bad ? '✗ ' : '✓ ') + files.length + ' fisiere verificate sintactic, ' + bad + ' erori.');
process.exit(bad ? 1 : 0);
