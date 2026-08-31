'use strict';

// Electorul se verifica fara timpi reali si fara o baza externa. Integrarea SQL a fencing-ului
// ramane in test/store-pg.js; aici demonstram schimbarea automata de lider si generatia monotona.

const { createCoordinator, envConfig, assertConfig } = require('../src/haCoordinator');

let pass = 0; let fail = 0;
function ok(name, value) { if (value) pass += 1; else { fail += 1; console.error('  ✗ ' + name); } }
function eq(name, got, expected) { ok(name + ' (got ' + JSON.stringify(got) + ', expected ' + JSON.stringify(expected) + ')', got === expected); }

class FakeLeaseBackend {
  constructor(shared) { this.shared = shared; }
  async open() { this.shared.opens += 1; }
  async acquire(input) {
    const s = this.shared;
    const cur = s.lease;
    if (!cur || cur.holder_id === input.holderId || cur.lease_until <= s.now) {
      const generation = !cur ? 1 : (cur.holder_id === input.holderId ? cur.generation : cur.generation + 1);
      s.lease = {
        name: input.name, holder_id: input.holderId, instance_label: input.instance,
        generation, lease_until: new Date(s.now + input.ttlMs), updated_at: new Date(s.now),
      };
    }
    return Object.assign({}, s.lease);
  }
  async release(input) {
    const x = this.shared.lease;
    if (x && x.holder_id === input.holderId && x.generation === input.generation) x.lease_until = new Date(this.shared.now);
  }
  async close() {}
}

const env = {
  CONTAB_HA_ENABLED: '1', CONTAB_DB_DRIVER: 'pg', CONTAB_HA_SHARED_STORAGE: '1',
  CONTAB_DATA_DIR: '/shared/contab', CONTAB_HA_LEASE_MS: '3000', CONTAB_HA_HEARTBEAT_MS: '1000',
  CONTAB_HA_REPLICAS: '2', CONTAB_HA_HOSTS: '2',
};

(async () => {
  const cfg = envConfig(env);
  ok('config HA recunoaste modul activ–pasiv', cfg.enabled && cfg.replicas === 2 && cfg.hosts === 2);
  let wrongDriver = null;
  try { assertConfig(Object.assign({}, cfg), Object.assign({}, env, { CONTAB_DB_DRIVER: 'sqlite' })); } catch (e) { wrongDriver = e; }
  ok('HA refuza SQLite (lease-ul trebuie distribuit)', wrongDriver && /PostgreSQL|pg/.test(wrongDriver.message));
  let localStorage = null;
  try { assertConfig(Object.assign({}, cfg, { sharedStorage: false }), env); } catch (e) { localStorage = e; }
  ok('HA refuza pornirea fara confirmarea stocarii partajate', localStorage && /SHARED_STORAGE|partajat/.test(localStorage.message));

  const shared = { now: Date.parse('2026-08-30T12:00:00Z'), lease: null, opens: 0 };
  let promotedA = 0; let promotedB = 0; let demotedA = 0;
  const a = createCoordinator({ config: Object.assign({}, cfg, { instance: 'node-a' }), env,
    backend: new FakeLeaseBackend(shared), promote: async () => { promotedA += 1; }, demote: async () => { demotedA += 1; } });
  const b = createCoordinator({ config: Object.assign({}, cfg, { instance: 'node-b' }), env,
    backend: new FakeLeaseBackend(shared), promote: async () => { promotedB += 1; } });

  await a.start();
  await b.start();
  ok('prima instanta este lider si ready', a.status().role === 'leader' && a.status().ready);
  ok('a doua instanta ramane standby si nu e ready', b.status().role === 'standby' && !b.status().ready);
  eq('numai liderul a rulat rehidratarea/promovarea', promotedA + '/' + promotedB, '1/0');
  const oldFence = a.fence();
  ok('liderul expune token complet de fencing', oldFence && oldFence.generation === 1 && oldFence.holderId);
  eq('standby-ul nu poate obtine token de scriere', b.fence(), null);

  await a.stop(); // release explicit: urmatorul tick poate promova fara asteptarea TTL
  await b.tick();
  ok('standby-ul este promovat automat dupa pierderea liderului', b.status().role === 'leader' && b.status().ready);
  eq('promovarea rehidrateaza o singura data', promotedB, 1);
  ok('generatia creste la schimbarea liderului', b.fence().generation === oldFence.generation + 1);
  ok('tokenul vechi nu coincide cu noul holder/generation', oldFence.holderId !== b.fence().holderId && oldFence.generation !== b.fence().generation);
  eq('oprirea liderului publica demiterea', demotedA, 1);

  // O eroare de reinnoire trebuie sa inchida readiness imediat, nu la expirarea locala estimata.
  const failing = { open: async () => {}, acquire: async () => { throw new Error('pg indisponibil'); }, close: async () => {} };
  const c = createCoordinator({ config: Object.assign({}, cfg, { instance: 'node-c' }), env, backend: failing });
  await c.start();
  ok('esecul electorului ramane fail-closed (standby, 503 readiness)', !c.status().ready && c.status().role === 'standby' && /pg indisponibil/.test(c.status().lastError));

  await b.stop(); await c.stop();
  console.log((fail ? '✗ ' : '✓ ') + pass + ' verificari HA trecute, ' + fail + ' esuate.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
