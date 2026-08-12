'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  RULEAZA TOATA SUITA — fara scurtcircuit
//
//  Inainte, `npm test` inlantuia suitele cu `&&`. Prima suita care iesea != 0 OPREA
//  restul: o singura poarta rosie (legitima) ascundea tacut ~1.270 de verificari,
//  inclusiv toata integrarea HTTP. Iesirea arata `✗ 1951 trecute, 1 esuata`, ceea ce
//  se citeste ca „o problema mica" — nu ca „doua treimi din suita nu au rulat".
//
//  Aici fiecare suita ruleaza INDEPENDENT, iar la final se raporteaza toate. Codul de
//  iesire ramane 1 daca vreuna a picat, deci CI si `prestart` se comporta la fel de
//  strict ca inainte — dar acum stii CE a picat si ce a trecut totusi.
//
//  Principiul e acelasi cu al portii fiscale: „n-am putut verifica" nu e „e bine".
//  O suita care nu a rulat trebuie sa fie VIZIBILA, nu absenta din raport.
// ─────────────────────────────────────────────────────────────────────────────

const cp = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Ordinea e cea din lantul original: de la ieftin/general (sintaxa) spre scump/integrat (HTTP).
// Se pastreaza fiindca la o cadere reala vrei sa vezi intai cauza generala, apoi efectele.
const SUITE = [
  'scripts/check-syntax.js',
  'test/db-guard.js',
  'test/auth.js',
  'test/run.js',
  'test/cazuri-aprobate.js',
  'test/extractor.js',
  'test/pdf.js',
  'test/frontend.mjs',
  'test/anaf.js',
  'test/store.js',
  'test/store-pg.js',
  'test/http.js',
];

// Formatele de raportare ale suitelor, toate pe acelasi tipar:
//   „✓ 1951 verificari trecute, 0 esuate."      „✓ 180 fisiere verificate sintactic, 0 erori."
//   „✓ 688 verificari HTTP trecute, 0 esuate."  „✓ 3 verificari garda DB trecute, 0 esuate."
const COUNT = /(\d+)\s+(?:verificari|fisiere)[^,]*,\s*(\d+)\s+(?:esuate|erori)/i;
// O suita se poate auto-sari motivat (store-pg fara CONTAB_PG_URL). „Sarit" NU e „trecut":
// se raporteaza distinct, ca sa nu para acoperire pe care nu o ai.
const SKIPPED = /\bSARIT\b/;

function run(rel) {
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(COUNT);
  return {
    rel,
    ok: r.status === 0,
    status: r.status == null ? 'semnal ' + r.signal : r.status,
    skipped: SKIPPED.test(out),
    trecute: m ? Number(m[1]) : null,
    esuate: m ? Number(m[2]) : null,
    ms: Date.now() - t0,
    out,
  };
}

const rezultate = [];
for (const s of SUITE) {
  // Iesirea suitei se tipareste imediat ce se termina — nu la final, ca sa ai
  // feedback pe masura ce avanseaza (http.js dureaza).
  process.stdout.write('\n── ' + s + '\n');
  const r = run(s);
  process.stdout.write(r.out.endsWith('\n') || !r.out ? r.out : r.out + '\n');
  rezultate.push(r);
}

// ── Raportul final ──
const picate = rezultate.filter((r) => !r.ok);
const totalTrecute = rezultate.reduce((a, r) => a + (r.trecute || 0), 0);
const totalEsuate = rezultate.reduce((a, r) => a + (r.esuate || 0), 0);

process.stdout.write('\n' + '='.repeat(72) + '\nREZUMAT SUITA\n' + '='.repeat(72) + '\n');
for (const r of rezultate) {
  const semn = r.ok ? (r.skipped ? '○' : '✓') : '✗';
  const cifre = r.trecute == null
    ? (r.skipped ? 'sarit' : '—')
    : r.trecute + ' trecute' + (r.esuate ? ', ' + r.esuate + ' esuate' : '');
  const cod = r.ok ? '' : '  [exit ' + r.status + ']';
  process.stdout.write(
    '  ' + semn + ' ' + r.rel.padEnd(26) + cifre.padEnd(26)
    + String(r.ms).padStart(6) + ' ms' + cod + '\n',
  );
}

const rulate = rezultate.length;
const verzi = rezultate.filter((r) => r.ok && !r.skipped).length;
const sarite = rezultate.filter((r) => r.skipped).length;
process.stdout.write('-'.repeat(72) + '\n');
process.stdout.write(
  rulate + ' suite rulate: ' + verzi + ' verzi, ' + picate.length + ' picate'
  + (sarite ? ', ' + sarite + ' sarite' : '')
  + '  —  ' + totalTrecute + ' verificari trecute'
  + (totalEsuate ? ', ' + totalEsuate + ' esuate' : '') + '.\n',
);

if (picate.length) {
  process.stdout.write('\nPICATE: ' + picate.map((r) => r.rel).join(', ') + '\n');
  // Esential: spune explicit ca restul CHIAR a rulat. Altfel primul reflex e
  // „probabil s-a oprit acolo", exact confuzia pe care o repara acest runner.
  process.stdout.write('Restul suitelor au rulat oricum (vezi rezumatul de mai sus).\n');
  process.exit(1);
}
process.stdout.write('\nToate suitele au trecut.\n');
