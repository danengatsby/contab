'use strict';

// Teste pentru bariera HTTP care transforma „am modificat RAM-ul” in „COMMIT confirmat”.
// Nu cer PostgreSQL real: coada este simulata controlat, inclusiv un commit lent si un rollback.

const express = require('express');
const http = require('http');
const { createDurabilityBarrier } = require('../src/durabilityBarrier');

let pass = 0; let fail = 0;
function ok(name, cond) {
  if (cond) pass += 1;
  else { fail += 1; console.error('  ✗ ' + name); }
}
function eq(name, got, exp) {
  if (got === exp) pass += 1;
  else { fail += 1; console.error('  ✗ ' + name + ': got ' + JSON.stringify(got) + ', expected ' + JSON.stringify(exp)); }
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function startApp(db, logger) {
  const app = express();
  app.use((req, res, next) => { req.reqId = 'test-rid'; next(); });
  app.use(createDurabilityBarrier(db, logger));
  app.get('/api/write', (req, res) => res.status(201).json({ ok: true }));
  app.get('/api/stream', (req, res) => { res.write('a'); res.end('b'); });
  app.get('/asset.txt', (req, res) => res.send('asset'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(server, path) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.get({ host: '127.0.0.1', port: addr.port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

function close(server) { return new Promise((resolve) => server.close(resolve)); }

(async () => {
  console.log('\nBariera HTTP de durabilitate PostgreSQL');

  {
    let calls = 0;
    const gate = deferred();
    const server = await startApp({ DRIVER: 'pg', flushStore: () => { calls += 1; return gate.promise; } });
    let finished = false;
    const response = get(server, '/api/write').then((r) => { finished = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    ok('raspunsul nu pleaca inainte de COMMIT', !finished);
    eq('flush este cerut o singura data', calls, 1);
    gate.resolve();
    const r = await response;
    eq('dupa COMMIT se pastreaza statusul rutei', r.status, 201);
    eq('dupa COMMIT se pastreaza corpul rutei', r.body, JSON.stringify({ ok: true }));
    await close(server);
  }

  {
    const errors = [];
    const server = await startApp(
      { DRIVER: 'pg', flushStore: () => Promise.reject(new Error('rollback de test')) },
      { error: (msg, ctx) => errors.push({ msg, ctx }) },
    );
    const r = await get(server, '/api/write');
    const body = JSON.parse(r.body);
    eq('ROLLBACK inlocuieste succesul cu 503', r.status, 503);
    ok('ROLLBACK nu mai livreaza corpul {ok:true}', body.ok !== true);
    eq('eroarea 503 este corelata prin reqId', body.reqId, 'test-rid');
    ok('esecul de commit este logat', errors.length === 1 && /commit PostgreSQL/.test(errors[0].msg));
    eq('Content-Length este recalculat pentru eroare', Number(r.headers['content-length']), Buffer.byteLength(r.body));
    await close(server);
  }

  {
    let calls = 0;
    const db = { DRIVER: 'pg', flushStore: () => { calls += 1; return Promise.resolve(); } };
    const server = await startApp(db);
    const asset = await get(server, '/asset.txt');
    eq('calea non-API nu este blocata de baza', asset.body, 'asset');
    eq('calea non-API nu cere flush', calls, 0);
    const stream = await get(server, '/api/stream');
    eq('un flux deja pornit ramane intact', stream.body, 'ab');
    eq('fluxul deja pornit nu pretinde ca poate schimba statusul', calls, 0);
    await close(server);
  }

  {
    let calls = 0;
    const db = {
      DRIVER: 'pg',
      persistStats: () => ({ pending: false, draining: false, failStreak: 0, conflicted: false }),
      flushStore: () => { calls += 1; return Promise.resolve(); },
    };
    const server = await startApp(db);
    const r = await get(server, '/api/write');
    eq('pg fara lucru in zbor pastreaza raspunsul', r.status, 201);
    eq('pg fara lucru in zbor foloseste calea rapida', calls, 0);
    await close(server);
  }

  {
    let calls = 0;
    const db = {
      DRIVER: 'pg',
      persistStats: () => ({ pending: false, draining: false, failStreak: 1, conflicted: false }),
      flushStore: () => { calls += 1; return Promise.reject(new Error('esec anterior')); },
    };
    const server = await startApp(db);
    const r = await get(server, '/api/write');
    eq('eroarea nevindecata nu foloseste calea rapida', r.status, 503);
    eq('eroarea nevindecata este verificata prin flush', calls, 1);
    await close(server);
  }

  {
    let calls = 0;
    const server = await startApp({ DRIVER: 'sqlite', flushStore: () => { calls += 1; return Promise.resolve(); } });
    const r = await get(server, '/api/write');
    eq('sqlite pastreaza raspunsul sincron', r.status, 201);
    eq('sqlite nu foloseste bariera PostgreSQL', calls, 0);
    await close(server);
  }

  console.log('\n' + (fail ? '✗' : '✓') + ' ' + pass + ' verificari durabilitate trecute, ' + fail + ' esuate.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
