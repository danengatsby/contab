'use strict';

const contract = require('../apiContract');

module.exports = function register(app) {
  app.get('/api/openapi.json', (req, res) => res.json(contract.openapi()));
};
