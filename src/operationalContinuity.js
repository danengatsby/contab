'use strict';

// Continuitatea nu se deduce din faptul ca /api/health raspunde ACUM. Verdictul combina topologia
// declarata cu probele persistate de backup/restaurare. Chiar cu toate probele verzi, un singur
// proces pe o singura masina ramane fara failover si nu poate fi prezentat drept HA contractuala.

const POLICY = Object.freeze({
  status: 'limited',
  scope: 'pilot_small_business',
  label: 'Continuitate limitată — pilot și firme mici',
  topology: Object.freeze({ processes: 1, hosts: 1, automaticFailover: false, highAvailability: false }),
  objectives: Object.freeze({
    rpo: Object.freeze({ assumedMinutes: 24 * 60, scope: 'pierderea totală a mașinii; ultima copie offsite zilnică' }),
    rto: Object.freeze({ assumedMinutes: 30, scope: 'revenire end-to-end, inclusiv operatorul și obținerea arhivei offsite' }),
    contractual: false,
  }),
  archiveDrillMaxAgeHours: 36, // backup zilnic + 12 h marja operationala
  defaultPgDrillDays: 7,
});

function parsedMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function ageHours(ts, nowMs) {
  const ms = parsedMs(ts);
  return ms == null ? null : Math.max(0, Math.round(((nowMs - ms) / 3600000) * 10) / 10);
}

function evaluate(lastVerified, opts) {
  const o = opts || {};
  const explicitNow = parsedMs(o.now);
  const nowMs = explicitNow == null ? Date.now() : explicitNow;
  const driver = String(o.databaseDriver || process.env.CONTAB_DB_DRIVER
    || (process.env.CONTAB_PG_URL ? 'pg' : 'sqlite')).toLowerCase();
  const configuredPgDays = Number(o.pgDrillDays || process.env.CONTAB_PG_DRILL_DAYS);
  const pgDrillDays = Number.isFinite(configuredPgDays) && configuredPgDays > 0
    ? configuredPgDays : POLICY.defaultPgDrillDays;
  const marker = lastVerified && typeof lastVerified === 'object' ? lastVerified : null;
  const ha = o.ha && typeof o.ha === 'object' ? o.ha : null;
  const haEnabled = !!(ha && ha.enabled);
  const haTopology = ha && ha.topology || {};
  const configuredReplicas = Number(haTopology.configuredReplicas) || 1;
  const topology = haEnabled ? {
    processes: configuredReplicas,
    hosts: Number(haTopology.configuredHosts) || 1,
    automaticFailover: configuredReplicas >= 2,
    highAvailability: configuredReplicas >= 2,
    mode: 'active-passive',
    leaderReady: !!ha.ready,
    sharedStorage: !!haTopology.sharedStorage,
    databaseFailover: !!haTopology.databaseFailover,
  } : POLICY.topology;

  const archiveAgeHours = ageHours(marker && marker.ts, nowMs);
  const archive = {
    required: true,
    lastTestAt: marker && marker.ts || null,
    ageHours: archiveAgeHours,
    maxAgeHours: POLICY.archiveDrillMaxAgeHours,
    verified: !!(marker && marker.ok === true && marker.drill && marker.drill.ok === true),
  };
  archive.fresh = archiveAgeHours != null && archiveAgeHours <= archive.maxAgeHours;
  archive.ready = archive.verified && archive.fresh;

  const off = marker && marker.offsite || {};
  const offsite = {
    required: true,
    objectStorageVerified: !!(off.objectStorage && off.objectStorage.status === 'ok'),
    encrypted: off.encrypted === true,
    encryptionVerified: off.encryptionVerified === true,
  };
  offsite.ready = offsite.objectStorageVerified && offsite.encrypted && offsite.encryptionVerified;

  const pg = marker && marker.pgDrill || null;
  const pgAgeHours = ageHours(pg && pg.ts, nowMs);
  const nativeDatabase = {
    applicable: driver === 'pg' || driver === 'postgres' || driver === 'postgresql',
    intervalDays: pgDrillDays,
    lastTestAt: pg && pg.ts || null,
    ageHours: pgAgeHours,
    verified: !!(pg && pg.ok === true),
    skipped: !!(pg && pg.sarit),
    reason: pg && pg.motiv || null,
  };
  nativeDatabase.fresh = pgAgeHours != null && pgAgeHours <= (pgDrillDays + 1) * 24;
  nativeDatabase.ready = !nativeDatabase.applicable || (nativeDatabase.verified && nativeDatabase.fresh);

  const blockers = [];
  if (topology.processes < 2) blockers.push('Este configurată mai puțin de două instanțe ale aplicației.');
  if (topology.hosts < 2) blockers.push('Instanțele aplicației nu sunt declarate pe cel puțin două mașini.');
  if (!topology.automaticFailover) blockers.push('Nu există failover automat.');
  if (haEnabled && !topology.leaderReady) blockers.push('Nicio instanță nu confirmă acum readiness de lider.');
  if (haEnabled && !topology.sharedStorage) blockers.push('Stocarea documentelor/auditului nu este declarată partajată.');
  if (haEnabled && !topology.databaseFailover) blockers.push('PostgreSQL rămâne fără un failover extern declarat.');
  if (!archive.verified) blockers.push('Ultima arhivă nu are un drill structural reușit.');
  else if (!archive.fresh) blockers.push('Drill-ul structural zilnic este expirat.');
  if (!offsite.ready) blockers.push('Copia offsite criptată nu are o probă completă și curentă.');
  if (nativeDatabase.applicable && !nativeDatabase.verified) blockers.push('Restaurarea nativă PostgreSQL nu este verificată.');
  else if (nativeDatabase.applicable && !nativeDatabase.fresh) blockers.push('Drill-ul nativ PostgreSQL este expirat.');

  const periodicRestoreTestsReady = archive.ready && nativeDatabase.ready;
  const recoveryEvidenceReady = periodicRestoreTestsReady && offsite.ready;
  const applicationFailoverReady = haEnabled && topology.processes >= 2
    && topology.automaticFailover && topology.leaderReady && topology.sharedStorage;
  const infrastructureFailoverReady = applicationFailoverReady && topology.hosts >= 2
    && topology.databaseFailover;
  const contractualSupported = infrastructureFailoverReady && recoveryEvidenceReady
    && !!haTopology.contractual;
  return {
    status: infrastructureFailoverReady ? 'ha_ready' : (applicationFailoverReady ? 'application_failover' : POLICY.status),
    scope: infrastructureFailoverReady ? 'multi_host' : (applicationFailoverReady ? 'multi_instance' : POLICY.scope),
    label: infrastructureFailoverReady
      ? 'Failover multi-instanță și multi-host pregătit'
      : (applicationFailoverReady ? 'Failover aplicație activ–pasiv pregătit; infrastructura rămâne de verificat' : POLICY.label),
    topology,
    objectives: Object.assign({}, POLICY.objectives, { contractual: contractualSupported }),
    tests: { archive, nativeDatabase, periodicRestoreTestsReady },
    offsite,
    recoveryEvidenceReady,
    applicationFailoverReady,
    infrastructureFailoverReady,
    contractualHighAvailability: {
      supported: contractualSupported,
      reason: contractualSupported
        ? 'Failoverul aplicației și al bazei, topologia multi-host și probele de restaurare sunt confirmate explicit.'
        : 'Failoverul aplicației nu devine automat SLA: sunt necesare minimum două gazde, PostgreSQL redundant, probe curente și asumare contractuală explicită.',
      blockers,
    },
  };
}

module.exports = { POLICY, evaluate, ageHours };
