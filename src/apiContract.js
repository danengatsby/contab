'use strict';

// Validator JSON Schema intentionat mic: acopera subsetul folosit de contractele interne si nu
// introduce o dependinta in calea de pornire. Aceleasi obiecte ajung in OpenAPI si la runtime.
function schemaError(path, message) {
  const e = new Error((path || 'payload') + ': ' + message); e.status = 400; e.code = 'API_PAYLOAD_INVALID'; return e;
}
function typeOk(type, value) {
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return true;
}
function validate(schema, value, path) {
  path = path || 'payload';
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];
  if (schema.type && !typeOk(schema.type, value)) return [schemaError(path, 'tip asteptat ' + schema.type)];
  if (schema.enum && !schema.enum.includes(value)) errors.push(schemaError(path, 'valoare admisa: ' + schema.enum.join(', ')));
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(schemaError(path, 'minimum ' + schema.minLength + ' caractere'));
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(schemaError(path, 'maximum ' + schema.maxLength + ' caractere'));
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) errors.push(schemaError(path, 'format invalid'));
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(schemaError(path, 'minimum ' + schema.minimum));
    if (schema.maximum != null && value > schema.maximum) errors.push(schemaError(path, 'maximum ' + schema.maximum));
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errors.push(schemaError(path, 'trebuie sa fie > ' + schema.exclusiveMinimum));
  }
  if (Array.isArray(value)) {
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(schemaError(path, 'maximum ' + schema.maxItems + ' elemente'));
    value.forEach((item, i) => errors.push(...validate(schema.items || {}, item, path + '[' + i + ']')));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(schemaError(path + '.' + key, 'camp obligatoriu'));
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(schemaError(path + '.' + key, 'camp necunoscut'));
    }
    for (const [key, child] of Object.entries(properties)) if (Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(...validate(child, value[key], path + '.' + key));
    }
  }
  return errors;
}
function assertSchema(schema, value, path) {
  const errors = validate(schema, value, path);
  if (errors.length) {
    const e = errors[0]; e.details = errors.map((x) => x.message); throw e;
  }
  return value;
}

const categoryKeys = ['ex_clienti', 'ex_furnizoriAngajati', 'ex_impozite', 'ex_dobanzi', 'ex_altele',
  'inv_imobilizari', 'inv_dobanziDiv', 'fin_credite', 'fin_capital', 'fin_dividende'];
const taxonomyKeys = ['taxable_confirmed', 'insurance_compensation_own_assets', 'foreign_income_taxed',
  'other_legal_subtraction', 'other_legal_addition'];
const reason = { type: 'string', minLength: 5, maxLength: 500 };
const hash256 = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const isoDate = { type: 'string', pattern: '^\\d{4}-(?:0[1-9]|1[0-2])-[0-3]\\d$' };
const stringList = { type: 'array', maxItems: 1000, items: { type: 'string', minLength: 1, maxLength: 300 } };
const schemas = Object.freeze({
  DocumentAiMode: { type: 'string', enum: ['firm-default', 'allow', 'deny'] },
  CashFlowClassification: { type: 'object', additionalProperties: false,
    properties: {
      version: { type: 'integer', enum: [1] },
      materialityAmount: { type: 'number', minimum: 0, maximum: 1e12 },
      materialityPercent: { type: 'number', minimum: 0, maximum: 100 },
      rules: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false,
        required: ['category', 'prefixes'], properties: {
          id: { type: 'string', maxLength: 80 }, label: { type: 'string', maxLength: 160 },
          category: { type: 'string', enum: categoryKeys },
          prefixes: { type: 'array', maxItems: 100, items: { type: 'string', pattern: '^\\d{1,12}(?:\\.\\d{1,12})?$' } },
        } } },
    }, required: ['rules', 'materialityAmount', 'materialityPercent'] },
  MicroTaxonomy: { type: 'object', additionalProperties: false, required: ['code', 'reason'], properties: {
    code: { type: 'string', enum: taxonomyKeys }, amount: { type: 'number', exclusiveMinimum: 0, maximum: 1e12 },
    reason, legalBasis: { type: 'string', maxLength: 160 }, sourceAccount: { type: 'string', maxLength: 30 },
  } },
  ProfitExpenseTreatment: { type: 'object', additionalProperties: false,
    required: ['lineIndex', 'account', 'category', 'reason'], properties: {
      lineIndex: { type: 'integer', minimum: 0 },
      account: { type: 'string', enum: ['635', '6581', '654'] },
      category: { type: 'string', minLength: 1, maxLength: 80 },
      reason,
      evidenceDocumentIds: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 120 } },
      evidenceReference: { type: 'string', maxLength: 500 },
    } },
  MicroAdjustment: { type: 'object', additionalProperties: false,
    required: ['period', 'direction', 'amount', 'category', 'legalBasis', 'reason'], properties: {
      period: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }, direction: { type: 'string', enum: ['add', 'subtract'] },
      amount: { type: 'number', exclusiveMinimum: 0, maximum: 1e12 }, category: { type: 'string', minLength: 1, maxLength: 160 },
      legalBasis: { type: 'string', minLength: 1, maxLength: 160 }, reason, entryId: { type: 'string', maxLength: 120 },
    } },
  MicroEligibilityRevision: { type: 'object', additionalProperties: false,
    required: ['reason', 'registry'], properties: {
      reason,
      when: { type: 'string', pattern: '^\\d{4}(?:-(?:0[1-9]|1[0-2]))?$' },
      registry: { type: 'object', required: ['ownershipCompleteThrough', 'workforceCompleteThrough',
        'evidenceReference', 'associates', 'linkedEnterprises', 'workforce', 'assetTransfers'], properties: {
        version: { type: 'integer', enum: [1] },
        registrationDate: { type: 'string', pattern: '^(?:|\\d{4}-(?:0[1-9]|1[0-2])-[0-3]\\d)$' },
        ownershipCompleteThrough: { type: 'string', pattern: '^\\d{4}-(?:0[1-9]|1[0-2])-[0-3]\\d$' },
        workforceCompleteThrough: { type: 'string', pattern: '^\\d{4}-(?:0[1-9]|1[0-2])-[0-3]\\d$' },
        evidenceReference: { type: 'string', minLength: 3, maxLength: 500 },
        associates: { type: 'array', maxItems: 500, items: { type: 'object' } },
        linkedEnterprises: { type: 'array', maxItems: 500, items: { type: 'object' } },
        workforce: { type: 'array', maxItems: 2000, items: { type: 'object' } },
        assetTransfers: { type: 'array', maxItems: 2000, items: { type: 'object' } },
      } },
    } },
  FiscalFactInput: { type: 'object', additionalProperties: false,
    required: ['subject', 'key', 'type', 'value', 'source', 'sourceHash', 'validFrom', 'confidence'],
    properties: {
      subject: { type: 'string', minLength: 1, maxLength: 300 },
      key: { type: 'string', pattern: '^[a-z][a-zA-Z0-9._-]*$', maxLength: 120 },
      type: { type: 'string', enum: ['money', 'number', 'boolean', 'string', 'date'] }, value: {},
      source: { type: 'object', additionalProperties: false, required: ['kind', 'id'], properties: {
        kind: { type: 'string', minLength: 1, maxLength: 120 }, id: { type: 'string', minLength: 1, maxLength: 500 },
        authority: { type: 'string', maxLength: 300 },
      } },
      sourceHash: hash256, validFrom: isoDate, validTo: isoDate,
      confidence: { type: 'string', enum: ['confirmed', 'declared', 'derived', 'disputed'] },
      supersedes: { type: 'string', maxLength: 160 }, note: { type: 'string', maxLength: 1000 },
    } },
  FiscalAutonomyPolicyInput: { type: 'object', additionalProperties: false,
    required: ['version', 'operations', 'valueLimits', 'allowedPartners', 'allowedDocumentTypes',
      'requiredDocuments', 'expiresAt', 'invalidation'],
    properties: {
      version: { type: 'integer', minimum: 1 }, status: { type: 'string', enum: ['active', 'revoked'] },
      operations: stringList, valueLimits: { type: 'object' }, allowedPartners: stringList,
      allowedDocumentTypes: stringList, requiredDocuments: stringList,
      expiresAt: { type: 'string', minLength: 20, maxLength: 40 },
      invalidation: { type: 'object', additionalProperties: false, properties: {
        fiscalRulesHash: hash256, treatmentRegistryHash: hash256,
        fiscalProfileHash: hash256, factRegistryHash: hash256,
      } },
      supersedes: { type: 'string', maxLength: 160 }, note: { type: 'string', maxLength: 1000 },
    } },
  FiscalEvaluationInput: { type: 'object', additionalProperties: false,
    required: ['ruleId', 'asOf'], properties: {
      ruleId: { type: 'string', minLength: 1, maxLength: 160 }, asOf: isoDate,
      subject: { type: 'string', maxLength: 300 }, operation: { type: 'string', maxLength: 160 },
      partnerId: { type: 'string', maxLength: 300 }, documentType: { type: 'string', maxLength: 160 },
      documents: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false,
        required: ['kind', 'hash'], properties: {
          kind: { type: 'string', minLength: 1, maxLength: 160 }, hash: hash256,
        } } },
    } },
  FiscalCounterfactualInput: { type: 'object', additionalProperties: false,
    required: ['ruleId', 'asOf', 'change'], properties: {
      ruleId: { type: 'string', minLength: 1, maxLength: 160 }, asOf: isoDate,
      subject: { type: 'string', maxLength: 300 },
      change: { type: 'object', additionalProperties: false, required: ['fact', 'value'], properties: {
        fact: { type: 'string', minLength: 1, maxLength: 120 }, value: {},
      } },
    } },
  Reason: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason } },
});

function openapi() {
  const json = (schema) => ({ required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/' + schema } } } });
  return {
    openapi: '3.1.0',
    info: { title: 'Contab API', version: '1.0.0', description: 'Contract incremental; operatiunile listate sunt validate la runtime din aceleasi scheme.' },
    'x-contab-contract-stage': 'governance-critical-flows',
    paths: {
      '/api/openapi.json': { get: { operationId: 'getApiContract', responses: { 200: { description: 'Contract OpenAPI' } } } },
      '/api/cash-flow/classification': {
        get: { operationId: 'getCashFlowClassification', responses: { 200: { description: 'Configuratie si taxonomie' } } },
        put: { operationId: 'putCashFlowClassification', requestBody: json('CashFlowClassification'), responses: { 200: { description: 'Configuratie salvata' }, 400: { description: 'Payload invalid' } } },
      },
      '/api/entries/{id}/fiscal-taxonomy/micro': {
        patch: { operationId: 'setMicroTransactionTaxonomy', requestBody: json('MicroTaxonomy'), responses: { 200: { description: 'Taxonomie salvata' }, 400: { description: 'Payload invalid' } } },
        delete: { operationId: 'removeMicroTransactionTaxonomy', requestBody: json('Reason'), responses: { 200: { description: 'Taxonomie retrasa' } } },
      },
      '/api/entries/{id}/fiscal-taxonomy/profit-expense': {
        patch: { operationId: 'setProfitExpenseTaxonomy', requestBody: json('ProfitExpenseTreatment'),
          responses: { 200: { description: 'Tratament fiscal salvat si auditat' }, 400: { description: 'Clasificare invalida' } } },
      },
      '/api/fiscal/micro/adjustments': {
        get: { operationId: 'listMicroAdjustments', responses: { 200: { description: 'Registru ajustari' } } },
        post: { operationId: 'createMicroAdjustment', requestBody: json('MicroAdjustment'), responses: { 200: { description: 'Ajustare inregistrata' }, 400: { description: 'Payload invalid' } } },
      },
      '/api/fiscal/micro/adjustments/{id}/revoke': {
        post: { operationId: 'revokeMicroAdjustment', requestBody: json('Reason'), responses: { 200: { description: 'Ajustare retrasa' } } },
      },
      '/api/fiscal/micro/eligibility': {
        get: { operationId: 'getMicroEligibilityRegistry', responses: { 200: { description: 'Registru versionat, graf si verdict cronologic' } } },
        put: { operationId: 'putMicroEligibilityRegistry', requestBody: json('MicroEligibilityRevision'),
          responses: { 200: { description: 'Revizie salvata si recalculata' }, 400: { description: 'Registru invalid' } } },
      },
      '/api/fiscal-engine/facts': {
        get: { operationId: 'listFiscalFacts', responses: { 200: { description: 'Fapte si rezolutie temporala' } } },
        post: { operationId: 'recordFiscalFact', requestBody: json('FiscalFactInput'),
          responses: { 201: { description: 'Fapt fiscal consemnat' }, 400: { description: 'Payload invalid' } } },
      },
      '/api/fiscal-engine/autonomy-policy': {
        get: { operationId: 'listFiscalAutonomyPolicies', responses: { 200: { description: 'Politici si versiunea activa' } } },
        post: { operationId: 'authorizeFiscalAutonomyPolicy', requestBody: json('FiscalAutonomyPolicyInput'),
          responses: { 201: { description: 'Politica autorizata' }, 400: { description: 'Payload invalid' } } },
      },
      '/api/fiscal-engine/evaluate': { post: { operationId: 'evaluateFiscalTreatment',
        requestBody: json('FiscalEvaluationInput'), responses: { 200: { description: 'Decizie fiscala verificabila' },
          400: { description: 'Payload invalid' } } } },
      '/api/fiscal-engine/counterfactual': { post: { operationId: 'evaluateFiscalCounterfactual',
        requestBody: json('FiscalCounterfactualInput'), responses: { 200: { description: 'Comparatie contrafactuala' },
          422: { description: 'Decizie de baza nedeterminabila' } } } },
      '/api/upload': { post: { operationId: 'uploadDocument', description: 'Multipart: file + aiMode per document.',
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file', 'aiMode'], properties: {
          file: { type: 'string', format: 'binary' }, aiMode: { $ref: '#/components/schemas/DocumentAiMode' },
        } } } } }, responses: { 200: { description: 'Document extras si decizie AI jurnalizata' } } } },
    },
    components: { schemas },
  };
}

module.exports = { schemas, validate, assertSchema, openapi };
