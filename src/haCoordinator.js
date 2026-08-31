'use strict';

// Coordonare HA activ–pasiv prin PostgreSQL.
//
// Aplicatia tine graful contabil in RAM, deci doua instante active simultan ar citi fotografii
// diferite si s-ar suprascrie. HA-ul sigur pentru arhitectura actuala este activ–pasiv:
//   1. PostgreSQL acorda un lease unui singur proces;
//   2. liderul isi rehidrateaza graful DUPA obtinerea lease-ului;
//   3. fiecare COMMIT este fenced cu holder+generation in storePg;
//   4. standby-ul raspunde la liveness/readiness, dar nu executa rute de business sau joburi.
// Generatia creste la fiecare schimbare de holder. Un proces vechi nu poate scrie nici daca
// reapare dupa o pauza de retea: tokenul lui nu mai corespunde randului de lease.

const crypto = require('crypto');
const os = require('os');
const { Pool } = require('pg');
const storePg = require('./storePg');

const API_PATH = /^\/(api|pdf|xml|csv|efactura)(?:\/|$)/;
const LEASE_TABLE = 'contab_ha_leases';

function asPositive(value, fallback, min) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? Math.round(n) : fallback;
}

function envConfig(env) {
  const e = env || process.env;
  const enabled = e.CONTAB_HA_ENABLED === '1';
  const ttlMs = asPositive(e.CONTAB_HA_LEASE_MS, 10000, 3000);
  const heartbeatMs = asPositive(e.CONTAB_HA_HEARTBEAT_MS, Math.max(1000, Math.floor(ttlMs / 3)), 500);
  return {
    enabled,
    leaseName: String(e.CONTAB_HA_LEASE_NAME || 'contab-primary').slice(0, 120),
    instance: String(e.CONTAB_INSTANCE_ID || os.hostname()).slice(0, 120),
    ttlMs,
    heartbeatMs: Math.min(heartbeatMs, Math.max(500, Math.floor(ttlMs / 2))),
    sharedStorage: e.CONTAB_HA_SHARED_STORAGE === '1',
    replicas: asPositive(e.CONTAB_HA_REPLICAS, enabled ? 2 : 1, 1),
    hosts: asPositive(e.CONTAB_HA_HOSTS, 1, 1),
    databaseFailover: e.CONTAB_HA_DATABASE_FAILOVER === '1',
    contractual: e.CONTAB_HA_CONTRACTUAL === '1',
  };
}

function assertConfig(config, env) {
  if (!config.enabled) return;
  const e = env || process.env;
  const driver = String(e.CONTAB_DB_DRIVER || '').toLowerCase();
  if (driver !== 'pg' && driver !== 'postgres' && driver !== 'postgresql') {
    throw new Error('CONTAB_HA_ENABLED=1 necesita CONTAB_DB_DRIVER=pg; SQLite/JSON nu pot arbitra un lease distribuit.');
  }
  if (!config.sharedStorage) {
    throw new Error('CONTAB_HA_ENABLED=1 necesita CONTAB_HA_SHARED_STORAGE=1 si CONTAB_DATA_DIR pe un volum partajat (uploaduri, audit si backupuri).');
  }
  if (!e.CONTAB_DATA_DIR) {
    throw new Error('CONTAB_HA_ENABLED=1 necesita CONTAB_DATA_DIR explicit, identic pe toate instantele si montat din stocarea partajata.');
  }
}

class PgLeaseBackend {
  constructor(opts) {
    const o = opts || {};
    this.pool = o.pool || new Pool(process.env.CONTAB_PG_URL
      ? { connectionString: process.env.CONTAB_PG_URL }
      : storePg.localPgConfig());
    this.ownsPool = !o.pool;
    this.table = LEASE_TABLE;
  }

  async open() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      name TEXT PRIMARY KEY,
      holder_id TEXT NOT NULL,
      instance_label TEXT NOT NULL,
      generation BIGINT NOT NULL,
      lease_until TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`);
  }

  async acquire(input) {
    const r = await this.pool.query(
      `INSERT INTO ${this.table} (name, holder_id, instance_label, generation, lease_until, updated_at)
       VALUES ($1, $2, $3, 1, clock_timestamp() + ($4::bigint * interval '1 millisecond'), clock_timestamp())
       ON CONFLICT (name) DO UPDATE SET
         holder_id = EXCLUDED.holder_id,
         instance_label = EXCLUDED.instance_label,
         generation = CASE
           WHEN ${this.table}.holder_id = EXCLUDED.holder_id THEN ${this.table}.generation
           ELSE ${this.table}.generation + 1
         END,
         lease_until = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
         updated_at = clock_timestamp()
       WHERE ${this.table}.holder_id = EXCLUDED.holder_id
          OR ${this.table}.lease_until <= clock_timestamp()
       RETURNING name, holder_id, instance_label, generation, lease_until, updated_at`,
      [input.name, input.holderId, input.instance, input.ttlMs]
    );
    if (r.rows.length) return r.rows[0];
    const current = await this.pool.query(
      `SELECT name, holder_id, instance_label, generation, lease_until, updated_at
         FROM ${this.table} WHERE name = $1`, [input.name]
    );
    return current.rows[0] || null;
  }

  async release(input) {
    await this.pool.query(
      `UPDATE ${this.table} SET lease_until = clock_timestamp(), updated_at = clock_timestamp()
        WHERE name = $1 AND holder_id = $2 AND generation = $3`,
      [input.name, input.holderId, input.generation]
    );
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

function normalizedLease(row) {
  if (!row) return null;
  return {
    name: row.name,
    holderId: row.holder_id,
    instance: row.instance_label,
    generation: Number(row.generation),
    leaseUntil: row.lease_until ? new Date(row.lease_until).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function createCoordinator(opts) {
  const o = opts || {};
  const config = o.config || envConfig(o.env);
  const backend = o.backend || (config.enabled ? new PgLeaseBackend(o) : null);
  const holderId = config.instance + ':' + process.pid + ':' + crypto.randomUUID();
  const listeners = new Set();
  let promote = typeof o.promote === 'function' ? o.promote : async () => {};
  let demote = typeof o.demote === 'function' ? o.demote : async () => {};
  let timer = null;
  let ticking = false;
  let stopped = false;
  let lease = null;
  let state = config.enabled ? 'starting' : 'standalone';
  let ready = !config.enabled;
  let lastError = null;
  let changedAt = new Date().toISOString();

  function snapshot() {
    return {
      enabled: config.enabled,
      state,
      role: !config.enabled ? 'standalone' : (ready && state === 'leader' ? 'leader' : 'standby'),
      ready: !config.enabled || (state === 'leader' && ready),
      instance: config.instance,
      holderId: config.enabled ? holderId : null,
      leaseName: config.enabled ? config.leaseName : null,
      generation: lease && lease.holderId === holderId ? lease.generation : null,
      leaseUntil: lease && lease.holderId === holderId ? lease.leaseUntil : null,
      currentLeader: lease && lease.instance || null,
      lastError,
      changedAt,
      topology: {
        configuredReplicas: config.replicas,
        configuredHosts: config.hosts,
        sharedStorage: config.sharedStorage,
        databaseFailover: config.databaseFailover,
        contractual: config.contractual,
      },
      lease: { ttlMs: config.ttlMs, heartbeatMs: config.heartbeatMs },
    };
  }

  function publish(next, error) {
    if (next) state = next;
    ready = !config.enabled || state === 'leader';
    lastError = error ? String(error.message || error).slice(0, 300) : null;
    changedAt = new Date().toISOString();
    const s = snapshot();
    for (const fn of listeners) {
      try { fn(s); } catch (_) { /* observatorul nu poate rupe electorul */ }
    }
  }

  async function loseLeadership(reason, error) {
    const wasLeader = state === 'leader' || state === 'promoting';
    // Un alt holder este starea normala a unei replici standby, nu o eroare. `lastError` ramane
    // rezervat esecului de PostgreSQL/promovare, altfel observabilitatea ar fi permanent rosie.
    publish('standby', error || null);
    if (wasLeader) {
      try { await demote(reason || 'lease pierdut'); } catch (_) { /* starea ramane fail-closed */ }
    }
  }

  async function tick() {
    if (!config.enabled || stopped || ticking) return snapshot();
    ticking = true;
    try {
      const row = normalizedLease(await backend.acquire({
        name: config.leaseName, holderId, instance: config.instance, ttlMs: config.ttlMs,
      }));
      lease = row;
      if (!row || row.holderId !== holderId) {
        await loseLeadership('lease detinut de alta instanta');
        return snapshot();
      }

      const alreadyLeader = state === 'leader' && ready && snapshot().generation === row.generation;
      if (!alreadyLeader) {
        ready = false;
        publish('promoting');
        try {
          await promote({ name: config.leaseName, holderId, generation: row.generation, leaseUntil: row.leaseUntil });
          // Promovarea poate dura mai mult decat TTL-ul. Reinnoieste/valideaza din nou IN BAZA
          // inainte de readiness; daca alt standby a preluat intre timp, tokenul vechi nu se
          // redeschide. Tranzactia de promovare a tinut randul FOR UPDATE cat a scris.
          const confirmed = normalizedLease(await backend.acquire({
            name: config.leaseName, holderId, instance: config.instance, ttlMs: config.ttlMs,
          }));
          lease = confirmed;
          if (!confirmed || confirmed.holderId !== holderId || confirmed.generation !== row.generation) {
            throw new Error('Lease-ul s-a schimbat in timpul rehidratarii; promovarea se reia.');
          }
          publish('leader');
        } catch (e) {
          await loseLeadership('promovare esuata', e);
        }
      } else {
        // Reinnoirea nu este o schimbare de rol; actualizeaza doar termenul fara zgomot in listeners.
        lastError = null;
      }
      return snapshot();
    } catch (e) {
      // La orice esec de reinnoire inchidem imediat readiness. E conservator (poate produce cateva
      // secunde de indisponibilitate), dar nu lasa un lider sa scrie pe presupunerea ca lease-ul
      // inca exista. Fencing-ul SQL ramane ultima bariera.
      await loseLeadership('reinnoirea lease-ului a esuat', e);
      return snapshot();
    } finally {
      ticking = false;
    }
  }

  function schedule() {
    if (!config.enabled || stopped || timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, config.heartbeatMs);
    if (timer.unref) timer.unref();
  }

  async function start(handlers) {
    if (!config.enabled) return snapshot();
    assertConfig(config, o.env);
    if (handlers && typeof handlers.promote === 'function') promote = handlers.promote;
    if (handlers && typeof handlers.demote === 'function') demote = handlers.demote;
    await backend.open();
    await tick();
    schedule();
    return snapshot();
  }

  function fence() {
    if (!config.enabled) return null;
    if (state !== 'leader' || !ready || !lease || lease.holderId !== holderId) return null;
    return { name: config.leaseName, holderId, generation: lease.generation };
  }

  async function fenceRejected(error) {
    await loseLeadership('COMMIT respins de fencing', error);
  }

  async function stop(stopOpts) {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    const own = fence();
    ready = false;
    if (own && (!stopOpts || stopOpts.release !== false)) {
      try { await backend.release(own); } catch (_) { /* va expira prin TTL */ }
    }
    await loseLeadership('instanta se opreste');
    if (backend) { try { await backend.close(); } catch (_) { /* ignora la shutdown */ } }
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    config, start, stop, tick, status: snapshot, fence, fenceRejected, onChange,
    isEnabled: () => config.enabled,
    isLeaderReady: () => snapshot().ready,
  };
}

const singleton = createCoordinator();

// Middleware-ul sta inaintea tuturor rutelor API. `/api/health` este liveness (proces viu),
// `/api/ready` este readiness (numai liderul). Pentru raspunsurile bufferizate verificam rolul
// si la `res.end`: o cerere lunga pornita ca lider nu poate confirma dupa demitere.
function readiness(req, res) {
  const s = singleton.status();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Contab-HA-Role', s.role);
  return res.status(s.ready ? 200 : 503).json({ ok: s.ready, role: s.role, instance: s.instance });
}

function middleware(req, res, next) {
  if (req.path === '/api/ready') return next();
  if (!singleton.isEnabled() || req.path === '/api/health' || !API_PATH.test(req.path || '')) return next();
  const before = singleton.status();
  res.setHeader('X-Contab-HA-Role', before.role);
  if (!before.ready) {
    res.setHeader('Retry-After', '2');
    return res.status(503).json({ error: 'Instanta standby; traficul este servit numai de lider.', code: 'CONTAB_HA_STANDBY' });
  }

  const originalEnd = res.end;
  res.end = function haEnd() {
    const args = Array.from(arguments);
    const current = singleton.status();
    if (!current.ready && !res.headersSent) {
      const body = JSON.stringify({ error: 'Instanta a pierdut rolul de lider in timpul cererii; operatiunea nu este confirmata.', code: 'CONTAB_HA_LEADERSHIP_LOST' });
      res.statusCode = 503;
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Encoding');
      res.removeHeader('ETag');
      res.setHeader('Retry-After', '2');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(body));
      return Reflect.apply(originalEnd, res, [req.method === 'HEAD' ? '' : body]);
    }
    return Reflect.apply(originalEnd, res, args);
  };
  return next();
}

module.exports = Object.assign(singleton, {
  createCoordinator, PgLeaseBackend, envConfig, assertConfig, middleware, readiness, LEASE_TABLE,
});
