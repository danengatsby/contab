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
const { F } = require('./helpers');

function fieldsForClient(t) {
  const fields = t.fields || [];
  // Scadenta este atribut al documentului comercial, nu al monografiei. O injectam pentru
  // formularele de factura/aviz fara sa copiem aceleasi doua campuri in zeci de tipuri.
  if (!/(factura|aviz|creanta|datorie)/.test(String(t.id)) || !fields.some((f) => f.name === 'partener')) return fields;
  if (fields.some((f) => f.name === 'scadenta')) return fields;
  const pos = fields.findIndex((f) => f.name === 'document');
  const out = fields.slice(); out.splice(pos >= 0 ? pos + 1 : 1, 0, F.scadenta, F.termenContractual);
  return out;
}

function getType(id) {
  return BY_ID.get(id);
}

/** Versiune "slim" pentru frontend (fara functia build). `entitate` = doar pentru srl/pfa. */
function typesForClient() {
  return TYPES.map((t) => ({ id: t.id, nume: t.nume, grup: t.grup, fields: fieldsForClient(t), entitate: t.entitate }));
}

module.exports = { TYPES, getType, typesForClient, fieldsForClient };
