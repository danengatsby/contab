'use strict';
const db = require('../src/db');
const { seed } = require('../src/seed');
// load() e sincron pe sqlite/json si asincron pe PostgreSQL; flushStore asteapta coada de scrieri pg.
Promise.resolve(db.load()).then(() => {
  const r = seed();
  console.log('Exemplu incarcat:', r.entries, 'inregistrari pentru', r.period);
  return db.flushStore();
}).catch((e) => { console.error('Seed esuat:', e.message); process.exit(1); });
