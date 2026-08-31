'use strict';

// Proba end-to-end HA pe PostgreSQL real: doua servere complete, un singur readiness, SIGKILL pe
// lider (fara release), promovarea standby-ului dupa TTL si revenirea fostului nod ca standby.
// Ruleaza numai din `npm run test-pg`, pe baza/containerul efemer al acelei suite.

if (!process.env.CONTAB_PG_URL) {
  console.log('ha-pg: SARIT — fara CONTAB_PG_URL (ruleaza `npm run test-pg`).');
  process.exit(0);
}

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

let pass = 0; let fail = 0;
function ok(name, value) { if (value) pass += 1; else { fail += 1; console.error('  ✗ ' + name); } }

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function probe(port, route) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + route, { signal: AbortSignal.timeout(1000) });
    let body = null; try { body = await res.json(); } catch (_) { /* raspunsul nu e JSON */ }
    return { status: res.status, body };
  } catch (_) { return { status: 0, body: null }; }
}

function childEnv(port, instance, dataDir, leaseName) {
  const env = Object.assign({}, process.env, {
    PORT: String(port), HOST: '127.0.0.1', CONTAB_DEV: '1', CONTAB_DB_DRIVER: 'pg',
    CONTAB_HA_ENABLED: '1', CONTAB_INSTANCE_ID: instance, CONTAB_HA_LEASE_NAME: leaseName,
    CONTAB_HA_LEASE_MS: '3000', CONTAB_HA_HEARTBEAT_MS: '500',
    CONTAB_HA_SHARED_STORAGE: '1', CONTAB_HA_REPLICAS: '2', CONTAB_HA_HOSTS: '1',
    CONTAB_DATA_DIR: dataDir, CONTAB_JSON_MIRROR: '0', CONTAB_RATE_API: '100000',
    CONTAB_AUTH_SECRET: 'a'.repeat(64), CONTAB_SECRETS_KEY: 'b'.repeat(64),
    STRIPE_SECRET_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CONTAB_HIBP: '0',
  });
  delete env.CONTAB_DB_FILE;
  delete env.CONTAB_TEST_DRIVER;
  return env;
}

function launch(port, instance, dataDir, leaseName) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'), env: childEnv(port, instance, dataDir, leaseName),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const take = (buf) => { output = (output + String(buf)).slice(-8000); };
  child.stdout.on('data', take); child.stderr.on('data', take);
  child.testOutput = () => output;
  return child;
}

async function waitElection(ports, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const states = await Promise.all(ports.map((p) => probe(p, '/api/ready')));
    if (states.filter((s) => s.status === 200).length === 1
      && states.filter((s) => s.status === 503).length === ports.length - 1) return states;
    await delay(150);
  }
  return Promise.all(ports.map((p) => probe(p, '/api/ready')));
}

async function terminate(child, signal) {
  if (!child || child.exitCode != null || child.signalCode) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* */ } resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill(signal || 'SIGTERM'); } catch (_) { clearTimeout(timer); resolve(); }
  });
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contab-ha-pg-'));
  const leaseName = 'contab-ha-e2e-' + process.pid;
  const ports = [await freePort(), await freePort()];
  let nodes = [launch(ports[0], 'ha-node-a', dataDir, leaseName), launch(ports[1], 'ha-node-b', dataDir, leaseName)];
  try {
    const initial = await waitElection(ports, 15000);
    const leaderIndex = initial.findIndex((s) => s.status === 200);
    const standbyIndex = leaderIndex === 0 ? 1 : 0;
    ok('doua servere complete aleg exact un lider ready', leaderIndex >= 0
      && initial[standbyIndex] && initial[standbyIndex].status === 503);
    ok('readiness identifica rolurile leader/standby', initial[leaderIndex] && initial[leaderIndex].body.role === 'leader'
      && initial[standbyIndex] && initial[standbyIndex].body.role === 'standby');
    if (leaderIndex < 0) throw new Error('Electia initiala a esuat.\nA:\n' + nodes[0].testOutput() + '\nB:\n' + nodes[1].testOutput());

    const started = Date.now();
    await terminate(nodes[leaderIndex], 'SIGKILL'); // fara eliberare: exercita TTL-ul, nu shutdown-ul fericit
    const promoted = await waitElection([ports[standbyIndex]], 10000);
    const elapsed = Date.now() - started;
    ok('standby-ul se promoveaza automat dupa crash brutal', promoted[0] && promoted[0].status === 200
      && promoted[0].body.role === 'leader');
    ok('failoverul ramane marginit de TTL + sonde (<8s in configuratia test)', elapsed < 8000);

    // Fostul nod revine cu alt holder_id de boot. Generatia existenta il tine standby; nu poate
    // deveni al doilea scriitor si nu are nevoie de curatarea vreunui lockfile local.
    nodes[leaderIndex] = launch(ports[leaderIndex], leaderIndex === 0 ? 'ha-node-a' : 'ha-node-b', dataDir, leaseName);
    const afterRestart = await waitElection(ports, 15000);
    ok('nodul repornit revine ca standby, nu ca al doilea lider', afterRestart.filter((s) => s.status === 200).length === 1
      && afterRestart[standbyIndex].status === 200 && afterRestart[leaderIndex].status === 503);
    ok('ambele procese raman vii dupa revenire', (await probe(ports[0], '/api/health')).status === 200
      && (await probe(ports[1], '/api/health')).status === 200);
  } finally {
    await Promise.all(nodes.map((n) => terminate(n, 'SIGTERM')));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log((fail ? '✗ ' : '✓ ') + pass + ' verificari HA PostgreSQL end-to-end trecute, ' + fail + ' esuate.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
