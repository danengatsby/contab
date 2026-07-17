'use strict';

// Tipurile de documente, sparte pe module tematice (ordinea de mai jos = ordinea din UI,
// exact cea din vechiul fisier monolit — nu o schimba fara motiv: e ordinea din select).
// Contractul fiecarui tip si helper-ele comune (L, F, TROZ, TVAL): ./helpers.js.

const TYPES = [
  ...require('./vanzari'),
  ...require('./cumparari'),
  ...require('./trezorerie'),
  ...require('./salarii'),
  ...require('./diverse'),
  ...require('./avansuri'),
  ...require('./sectoare'),
  ...require('./tvaIncasare'),
  ...require('./imobilizari'),
  ...require('./financiar'),
  ...require('./fiscalSpecial'),
  ...require('./pfaAvize'),
];

const BY_ID = new Map(TYPES.map((t) => [t.id, t]));

function getType(id) {
  return BY_ID.get(id);
}

/** Versiune "slim" pentru frontend (fara functia build). `entitate` = doar pentru srl/pfa. */
function typesForClient() {
  return TYPES.map((t) => ({ id: t.id, nume: t.nume, grup: t.grup, fields: t.fields, entitate: t.entitate }));
}

module.exports = { TYPES, getType, typesForClient };
