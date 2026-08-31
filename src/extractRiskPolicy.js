'use strict';

// POLITICA DE RISC pentru pregatirea automata a unei ciorne.
//
// Separarea este deliberata:
//   * extractorul AI propune fapte, tipul si un scor despre propria iesire;
//   * extractQuality executa controale deterministe asupra propunerii;
//   * acest modul decide auto-ciorna sau abstentionare din controale + rezultate REALE revizuite;
//   * documentTypes/entriesService calculeaza si contabilizeaza, fara formule produse de LLM.
//
// Scorul AI nu este o dovada si nu autorizeaza direct nimic. El este doar cheia unei benzi de
// calibrare: un scor 99 fara documente comparate cu verdictul unui om ramane necalibrat.

const crypto = require('crypto');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value); Object.values(value).forEach(deepFreeze); return value;
}

const POLICY_SCHEMA = 1;
const POLICY_ID = 'document-auto-draft-risk-v1';
const MIN_REVIEWED_SAMPLES = 30;
const MAX_SAMPLES = 200;
const CALIBRATION_WINDOW_DAYS = 180;
const MAX_CORRECTION_RATE = 5;
const FISCAL_FIELDS = new Set(['baza', 'tva', 'cota', 'suma', 'brut']);
const SCORE_BANDS = deepFreeze([
  { id: '0-49', min: 0, max: 49 },
  { id: '50-69', min: 50, max: 69 },
  { id: '70-84', min: 70, max: 84 },
  { id: '85-94', min: 85, max: 94 },
  { id: '95-100', min: 95, max: 100 },
]);

const POLICY_CONTRACT = deepFreeze({
  schemaVersion: POLICY_SCHEMA, id: POLICY_ID, minimumReviewedSamples: MIN_REVIEWED_SAMPLES,
  maximumSamples: MAX_SAMPLES, calibrationWindowDays: CALIBRATION_WINDOW_DAYS,
  maximumCorrectionRate: MAX_CORRECTION_RATE, fiscalCorrectionsAllowed: 0,
  calibrationDimensions: ['source', 'provider', 'model', 'format', 'documentType', 'confidenceBand'],
  fiscalFields: [...FISCAL_FIELDS].sort(), scoreBands: SCORE_BANDS,
});
const POLICY_HASH = crypto.createHash('sha256').update(JSON.stringify(POLICY_CONTRACT)).digest('hex');

function confidenceBand(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return null;
  const score = Number(value);
  const band = SCORE_BANDS.find((row) => score >= row.min && score <= row.max);
  return band ? band.id : null;
}

function extractionKey(extraction) {
  const row = extraction || {};
  return {
    source: String(row.source || 'necunoscut'),
    provider: row.provider ? String(row.provider) : null,
    model: row.model ? String(row.model) : null,
    format: String(row.format || 'necunoscut').toLowerCase(),
    documentType: row.suggestedType ? String(row.suggestedType)
      : row.tipExtras ? String(row.tipExtras) : null,
    confidenceBand: confidenceBand(row.incredere),
  };
}

function sameKey(intervention, key) {
  const row = intervention || {};
  return String(row.source || 'necunoscut') === key.source
    && (row.provider ? String(row.provider) : null) === key.provider
    && (row.model ? String(row.model) : null) === key.model
    && String(row.format || 'necunoscut').toLowerCase() === key.format
    && (row.tipExtras ? String(row.tipExtras) : row.suggestedType ? String(row.suggestedType) : null) === key.documentType
    && confidenceBand(row.incredere) === key.confidenceBand;
}

function fiscalCorrection(row) {
  const diff = row && row.diff || {};
  return diff.tipSchimbat === true || (diff.campuri || []).some((item) => FISCAL_FIELDS.has(String(item && item.camp || '')));
}

function roundRate(part, total) { return total ? Math.round((part / total) * 10000) / 100 : 0; }

function calibration(interventions, extraction, options) {
  const opts = options || {};
  const now = opts.now == null ? Date.now() : new Date(opts.now).getTime();
  const cutoff = new Date(now - CALIBRATION_WINDOW_DAYS * 86400000).toISOString();
  const key = extractionKey(extraction);
  const rows = (interventions || []).filter((row) => row && row.at >= cutoff && sameKey(row, key))
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, MAX_SAMPLES);
  const corrections = rows.filter((row) => row.corectat === true).length;
  const fiscalCorrections = rows.filter(fiscalCorrection).length;
  const correctionRate = roundRate(corrections, rows.length);
  const calibratable = key.source === 'ai' && !!key.provider && !!key.model
    && !!key.documentType && !!key.confidenceBand;
  const sufficient = rows.length >= MIN_REVIEWED_SAMPLES;
  const accepted = calibratable && sufficient && correctionRate <= MAX_CORRECTION_RATE && fiscalCorrections === 0;
  return {
    key, samples: rows.length, corrections, fiscalCorrections, correctionRate,
    minimumSamples: MIN_REVIEWED_SAMPLES, maximumCorrectionRate: MAX_CORRECTION_RATE,
    windowDays: CALIBRATION_WINDOW_DAYS,
    status: !calibratable ? 'ineligible' : !sufficient ? 'insufficient' : accepted ? 'calibrated' : 'rejected',
    accepted,
  };
}

function decide(input) {
  const args = input || {}; const quality = args.quality || {};
  const blocking = (quality.controale || []).filter((row) => row.blocant && !row.ok);
  const base = {
    schemaVersion: POLICY_SCHEMA, policyId: POLICY_ID, policyHash: POLICY_HASH,
    decision: 'abstain', deterministicEngine: 'document-types-v1',
    confidenceRole: 'calibration-key-only', calibration: null, reasons: [],
  };
  if (!Array.isArray(quality.controale) || !quality.controale.length) return Object.assign(base, {
    code: 'deterministic_checks_unavailable',
    reasons: ['Politica nu a primit rezultatele controalelor deterministe.'],
  });
  if (blocking.length) return Object.assign(base, {
    code: 'deterministic_checks_failed',
    reasons: blocking.map((row) => row.motiv).filter(Boolean),
  });
  if (quality.verdictDeterminist !== 'trecut') return Object.assign(base, {
    code: 'deterministic_verdict_invalid',
    reasons: ['Verdictul controalelor deterministe lipsește sau este invalid.'],
  });

  const extraction = extractionKey(args.extraction);
  if (extraction.source !== 'ai') return Object.assign(base, {
    code: 'source_not_calibrated',
    reasons: ['Extragerea fără AI nu are o calibrare eligibilă pentru pregătire automată.'],
  });
  if (!extraction.provider || !extraction.model) return Object.assign(base, {
    code: 'extractor_identity_missing',
    reasons: ['Furnizorul și modelul extractorului trebuie identificate pentru calibrare.'],
  });
  if (!extraction.documentType) return Object.assign(base, {
    code: 'document_type_missing',
    reasons: ['Tipul propus al documentului lipsește din cheia de calibrare.'],
  });
  if (!extraction.confidenceBand) return Object.assign(base, {
    code: 'confidence_band_missing',
    reasons: ['Scorul extractorului lipsește sau este în afara intervalului 0–100; banda nu poate fi calibrată.'],
  });

  const observed = calibration(args.interventions, args.extraction, { now: args.now });
  if (!observed.accepted) return Object.assign(base, {
    code: observed.status === 'insufficient' ? 'calibration_insufficient' : 'calibration_rejected',
    calibration: observed,
    reasons: observed.status === 'insufficient'
      ? ['Abstentionare: banda are ' + observed.samples + '/' + observed.minimumSamples
        + ' documente reale revizuite. Scorul AI singur nu autorizează automatizarea.']
      : ['Abstentionare: rata observată de corecție este ' + observed.correctionRate + '% și există '
        + observed.fiscalCorrections + ' corecții cu impact fiscal.'],
  });
  return Object.assign(base, {
    decision: 'auto_draft', code: 'calibrated_low_risk', calibration: observed,
    reasons: ['Controalele deterministe au trecut, iar banda extractorului este calibrată pe documente reale revizuite.'],
  });
}

function report(interventions, options) {
  const opts = options || {}; const seen = new Map();
  for (const row of interventions || []) {
    const key = extractionKey(row); const id = JSON.stringify(key);
    if (!seen.has(id)) seen.set(id, row);
  }
  return [...seen.values()].map((row) => calibration(interventions, row, opts))
    .filter((row) => row.samples > 0)
    .sort((a, b) => b.samples - a.samples || JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)));
}

module.exports = {
  POLICY_SCHEMA, POLICY_ID, POLICY_HASH, POLICY_CONTRACT, MIN_REVIEWED_SAMPLES, MAX_SAMPLES,
  CALIBRATION_WINDOW_DAYS, MAX_CORRECTION_RATE, SCORE_BANDS,
  confidenceBand, extractionKey, calibration, decide, report,
};
