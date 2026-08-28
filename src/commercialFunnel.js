'use strict';

// Funnelul COMERCIAL, separat deliberat de src/visitors.js.
//
// `visitors` este un control de securitate agregat pe IP. Aici nu se citeste si nu se pastreaza
// IP-ul, calea completa, browserul ori vreun identificator anonim. Se pastreaza numai contoare
// zilnice si totale, iar pe cont/firma data la care o etapa unica a fost atinsa prima oara.
// Consecinta asumata: „vizite” inseamna incarcari ale paginilor publice de intrare, nu persoane
// unice, iar trecerea anonima vizita -> demo -> inscriere nu poate fi atribuita aceleiasi persoane.

const RETENTION_DAYS = 400;
const SCHEMA_VERSION = 1;

const STAGES = Object.freeze([
  { id: 'visit', label: 'Vizite publice', description: 'Încărcări reușite ale paginilor de intrare, fără roboți declarați.', base: null },
  { id: 'demo', label: 'Demo pornit', description: 'Sesiuni demo pornite cu succes.', base: 'visit' },
  { id: 'signup', label: 'Înscriere', description: 'Conturi noi create cu succes.', base: 'visit' },
  { id: 'company_configured', label: 'Firmă configurată', description: 'Firme care au completat toate datele cerute de generatoare.', base: 'signup' },
  { id: 'first_document', label: 'Primul document', description: 'Firme cu primul articol contabil care nu este generat de sistem.', base: 'company_configured' },
  { id: 'first_month_closed', label: 'Prima lună închisă', description: 'Firme care au finalizat și blocat prima perioadă lunară.', base: 'first_document' },
  { id: 'payment', label: 'Plată', description: 'Prima activare plătită confirmată prin Stripe sau de administrator.', base: 'signup' },
]);

const STAGE_IDS = new Set(STAGES.map((s) => s.id));
const LANDING_PATHS = new Set(['/', '/prezentare.html']);
const RE_BOT = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|curl|wget|python-requests|go-http-client|scrapy|nmap|masscan|zgrab/i;
let revision = 0;
let persistedRevision = 0;

function emptyCounts() {
  return Object.fromEntries(STAGES.map((s) => [s.id, 0]));
}

function validIso(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

function normalizeCounts(value) {
  const out = emptyCounts();
  for (const id of STAGE_IDS) out[id] = Math.max(0, Math.floor(Number(value && value[id]) || 0));
  return out;
}

function ensure(graph, at) {
  const d = graph || {};
  d.settings = d.settings || {};
  let state = d.settings.commercialFunnel;
  if (!state || Number(state.schemaVersion) !== SCHEMA_VERSION) {
    state = {
      schemaVersion: SCHEMA_VERSION,
      startedAt: validIso(at),
      updatedAt: null,
      totals: emptyCounts(),
      daily: {},
    };
    d.settings.commercialFunnel = state;
  }
  state.startedAt = validIso(state.startedAt || at);
  state.totals = normalizeCounts(state.totals);
  if (!state.daily || typeof state.daily !== 'object' || Array.isArray(state.daily)) state.daily = {};
  return state;
}

function pruneDaily(state, now) {
  const limit = new Date(Date.parse(now) - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  for (const day of Object.keys(state.daily)) if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < limit) delete state.daily[day];
}

/** Inregistreaza UN eveniment agregat. Nu accepta si nu pastreaza metadate despre persoana. */
function record(graph, stage, options) {
  if (!STAGE_IDS.has(stage)) throw new Error('Etapă comercială necunoscută: ' + stage);
  const at = validIso(options && options.at);
  const state = ensure(graph, at);
  const day = at.slice(0, 10);
  state.totals[stage] += 1;
  state.daily[day] = normalizeCounts(state.daily[day]);
  state.daily[day][stage] += 1;
  state.updatedAt = at;
  pruneDaily(state, at);
  revision += 1;
  return state.totals[stage];
}

function isDemoEntity(entity) {
  return !!(entity && (entity.demo === true || entity.test === true
    || /^demo(?:-contabil)?$/i.test(String(entity.username || ''))));
}

/**
 * Marcheaza o etapa care se numara o singura data pe cont/firma.
 * `count:false` migreaza/baselineaza o entitate veche fara sa inventeze o conversie noua.
 */
function markEntity(graph, entity, stage, options) {
  if (!entity || isDemoEntity(entity)) return false;
  if (!STAGE_IDS.has(stage) || stage === 'visit' || stage === 'demo') {
    throw new Error('Etapa nu poate fi marcată pe entitate: ' + stage);
  }
  const at = validIso(options && options.at);
  const milestones = entity.commercialMilestones = entity.commercialMilestones || {};
  const key = stage + 'At';
  if (milestones[key]) return false;
  milestones[key] = at;
  if (!options || options.count !== false) record(graph, stage, { at });
  return true;
}

/** Pagina de intrare, fara identificarea vizitatorului si fara reutilizarea registrului pe IP. */
function noteLanding(graph, req, statusCode) {
  const r = req || {};
  const headers = r.headers || {};
  const path = String(r.path || r.url || '').split('?')[0];
  if (r.method !== 'GET' || !LANDING_PATHS.has(path)) return false;
  if (Number(statusCode) < 200 || Number(statusCode) >= 400) return false;
  if (!/text\/html/i.test(String(headers.accept || ''))) return false;
  if (RE_BOT.test(String(headers['user-agent'] || ''))) return false;
  record(graph, 'visit');
  return true;
}

function countsForRange(state, days, now) {
  if (days == null) return normalizeCounts(state.totals);
  const end = new Date(now || Date.now());
  const endDay = end.toISOString().slice(0, 10);
  const start = new Date(end.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const out = emptyCounts();
  for (const [day, counts] of Object.entries(state.daily || {})) {
    if (day < start || day > endDay) continue;
    const c = normalizeCounts(counts);
    for (const id of STAGE_IDS) out[id] += c[id];
  }
  return out;
}

function snapshot(graph, options) {
  const raw = graph && graph.settings && graph.settings.commercialFunnel;
  const state = raw || { schemaVersion: SCHEMA_VERSION, startedAt: null, updatedAt: null, totals: emptyCounts(), daily: {} };
  const requested = options && options.days;
  const days = requested === null || requested === 'all' ? null : ([30, 90].includes(Number(requested)) ? Number(requested) : 30);
  const counts = countsForRange(state, days, options && options.now);
  const stages = STAGES.map((def) => {
    const baseCount = def.base ? counts[def.base] : null;
    const baseDef = def.base ? STAGES.find((x) => x.id === def.base) : null;
    return Object.assign({}, def, {
      count: counts[def.id],
      baseCount,
      baseLabel: baseDef ? baseDef.label : null,
      conversionPct: baseCount > 0 ? Math.round((counts[def.id] / baseCount) * 1000) / 10 : null,
    });
  });
  const endDay = new Date(options && options.now || Date.now()).toISOString().slice(0, 10);
  const startDay = days == null ? null
    : new Date(Date.parse(endDay + 'T00:00:00.000Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
  const daily = Object.keys(state.daily || {}).filter((day) => day <= endDay && (!startDay || day >= startDay))
    .sort().reverse().slice(0, days || RETENTION_DAYS).map((day) => ({
    day,
    counts: normalizeCounts(state.daily[day]),
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    startedAt: state.startedAt || null,
    updatedAt: state.updatedAt || null,
    range: { days, label: days == null ? 'De la activarea măsurării' : 'Ultimele ' + days + ' zile' },
    stages,
    daily,
    privacy: {
      anonymousIdentityStored: false,
      uniqueVisitors: false,
      statement: 'Vizitele sunt încărcări de pagină agregate; nu se stochează IP, cookie analitic, browser sau identificator de vizitator.',
    },
  };
}

function isDirty() { return revision !== persistedRevision; }
function markPersisted() { persistedRevision = revision; }
function _resetDirty() { revision = 0; persistedRevision = 0; }

module.exports = {
  STAGES, RETENTION_DAYS, SCHEMA_VERSION,
  record, markEntity, noteLanding, snapshot, isDirty, markPersisted, _resetDirty,
};
