'use strict';
// Genereaza N inregistrari sintetice pe firma 1 (ruleaza INAINTE de pornirea serverului de test; NU pe productie).
const N = Number(process.argv[2] || 10000);
const db = require('../src/db.js');
db.load();
const d = db.get();
const TYPES = [
  ['factura_vanzare_servicii', [['4111', '704'], ['4111', '4427']]],
  ['factura_cumparare_marfuri', [['371', '401'], ['4426', '401']]],
  ['incasare_client', [['5121', '4111']]],
  ['plata_furnizor', [['401', '5121']]],
];
d.entries = d.entries.filter((e) => e.firmaId !== 1 || !String(e.explicatie || '').startsWith('bench'));
let id = 1;
for (let i = 0; i < N; i++) {
  const luna = String(1 + (i % 12)).padStart(2, '0');
  const zi = String(1 + (i % 28)).padStart(2, '0');
  const [tip, formule] = TYPES[(i + (i / 12 | 0)) % TYPES.length]; // decorelat de luna (12 % 4 == 0)
  const suma = 100 + (i % 900);
  d.entries.push({
    id: 'be' + (id++), firmaId: 1, data: `2026-${luna}-${zi}`, period: `2026-${luna}`,
    tip, tipNume: tip, partener: 'PARTENER ' + (i % 200), partenerCui: String(10000000 + (i % 200)),
    document: 'B' + i, analitic: '', explicatie: 'bench ' + i, items: [], fileId: null, system: false,
    lines: formule.map(([de, cr]) => ({ debit: de, credit: cr, suma, explicatie: 'bench' })),
  });
}
db.save();
console.log('generat', N, 'inregistrari; total in baza:', d.entries.length);
