'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  RETENTIA BUCKETULUI OFFSITE — citita si aplicata din depozit, nu din consola
//
//  Fara ea, bucketul creste la nesfarsit: cheile obiectelor sunt datate, deci nimic nu se
//  suprascrie niciodata (spre deosebire de arhivele locale, rotite prin CONTAB_BACKUP_KEEP_FULL).
//
//  De ce o comanda si nu un clic in consola furnizorului: o regula pusa cu mana e configuratie
//  invizibila — nu se poate reface dupa o migrare, nu se vede la revizie si nimic nu semnaleaza
//  daca cineva o schimba. Aceeasi lectie ca la configul nginx (`npm run nginx-drift`).
//
//  Folosire:
//    npm run offsite-retentie            arata regula VIE si o compara cu cea din cod
//    npm run offsite-retentie -- --aplica  o scrie pe bucket, apoi o citeste inapoi
//
//  Iesire: 0 = regula vie coincide cu cea din cod | 1 = DIFERITA sau eroare | 2 = NECONFIGURAT
//  Distinctia 1 vs 2 e deliberata, ca la poarta fiscala: „n-am putut verifica" nu e „e bine".
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');

require('../src/bootstrap').loadDotEnv(path.join(__dirname, '..'));
const offsite = require('../src/offsite');

const APLICA = process.argv.includes('--aplica');

async function main() {
  console.log('Retentia bucketului offsite\n');

  const cfg = offsite.fromEnv(process.env);
  if (!offsite.configured(cfg)) {
    console.log('  ⚠ NECONFIGURAT — lipsesc variabilele CONTAB_OFFSITE_*.');
    console.log('    Fara bucket nu exista retentie de verificat. Vezi docs/rulare.md.');
    process.exit(2);
  }

  const dorit = offsite.lifecycleXml(cfg.prefix, offsite.RETENTIE_ZILE, offsite.RETENTIE_MULTIPART_ZILE);
  const asteptat = offsite.lifecycleSummary(dorit);
  console.log('Regula din cod (src/offsite.js):');
  console.log('  prefix „' + asteptat.prefix + '" · sterge dupa ' + asteptat.zile + ' zile'
    + ' · abandoneaza urcarile intrerupte dupa ' + asteptat.zileMultipart + ' zile\n');

  if (APLICA) {
    await offsite.putBucketLifecycle(cfg, dorit);
    console.log('  ✓ regula scrisa pe ' + cfg.bucket);
  }

  // Se citeste INAPOI de pe server, mereu: un PUT cu 200 spune ca cererea a fost acceptata, nu ca
  // furnizorul a pastrat exact ce i-am dat (unii normalizeaza campurile ori ignora ce nu suporta).
  const viu = await offsite.getBucketLifecycle(cfg);
  const acum = offsite.lifecycleSummary(viu);
  if (!acum) {
    console.log('  ✗ bucketul „' + cfg.bucket + '" NU are nicio regula de retentie.');
    console.log('    Aplic-o cu: npm run offsite-retentie -- --aplica');
    process.exit(1);
  }

  console.log('Regula VIE pe bucketul „' + cfg.bucket + '":');
  console.log('  prefix „' + acum.prefix + '" · ' + (acum.activa ? 'activa' : 'INACTIVA')
    + ' · sterge dupa ' + acum.zile + ' zile · urcari intrerupte dupa ' + acum.zileMultipart + ' zile\n');

  const dif = [];
  if (acum.prefix !== asteptat.prefix) dif.push('prefix: ' + acum.prefix + ' ≠ ' + asteptat.prefix);
  if (acum.zile !== asteptat.zile) dif.push('zile: ' + acum.zile + ' ≠ ' + asteptat.zile);
  if (acum.zileMultipart !== asteptat.zileMultipart) dif.push('zile multipart: ' + acum.zileMultipart + ' ≠ ' + asteptat.zileMultipart);
  if (!acum.activa) dif.push('regula e dezactivata pe server');

  if (dif.length) {
    console.log('DRIFT — regula vie nu e cea din cod:');
    for (const d of dif) console.log('  ✗ ' + d);
    console.log('\n  Reaplica cu: npm run offsite-retentie -- --aplica');
    process.exit(1);
  }
  console.log('VERDE — regula vie coincide cu cea din cod.');
  process.exit(0);
}

main().catch((e) => { console.error('offsite-retentie: ' + e.message); process.exit(1); });
