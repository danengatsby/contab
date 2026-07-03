'use strict';
const db = require('../src/db');
const { seed } = require('../src/seed');
db.load();
const r = seed();
console.log('Exemplu incarcat:', r.entries, 'inregistrari pentru', r.period);
