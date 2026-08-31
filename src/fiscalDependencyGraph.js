'use strict';

// Graful de invalidare al aprobarilor pentru poarta de lansare. Manifestul global ramane util
// pentru inventar si audit, dar nu mai este o dependenta a fiecarui caz. Graful urmareste
// inchiderea importurilor locale si inlocuieste fisierele fiscale monolitice cu noduri semantice:
// parametri exacti, tratamente exacte si componentele de calcul care le consuma.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GRAPH_SCHEMA = 1;
const ROOT = path.join(__dirname, '..');
const SPECIAL_FILES = new Set(['src/fiscalConfig.js', 'src/fiscal.js', 'src/fiscalTreatments.js']);
const COMPONENT_RANGES = Object.freeze({
  'fiscal.engine': ["'use strict';", 'const DEFAULTS ='],
  'fiscal.registry': ['const DEFAULTS =', 'const DP_PCT_MAX ='],
  'fiscal.deduction': ['const DP_PCT_MAX =', 'function salariuMinimLa'],
  'fiscal.minimum_wage': ['function salariuMinimLa', 'function categoriiBeneficii'],
  'fiscal.benefits': ['function categoriiBeneficii', 'function payroll'],
  'fiscal.payroll': ['function payroll', 'function retinereLaSursa'],
  'fiscal.withholding': ['function retinereLaSursa', 'function taxePfa'],
  'fiscal.pfa': ['function taxePfa', 'module.exports ='],
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function normalizePath(value) { return String(value || '').split(path.sep).join('/').replace(/^\.\//, ''); }

function manifestHashes(manifest) {
  return new Map(((manifest && manifest.entries) || []).map((row) => [normalizePath(row.path), row.sha256]));
}

function resolveLocal(root, from, request) {
  if (!String(request).startsWith('.')) return null;
  const base = path.resolve(root, path.dirname(from), request);
  const candidates = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
  const absolute = candidates.find((candidate) => fs.existsSync(candidate) && fs.lstatSync(candidate).isFile());
  if (!absolute) return { error: from + ': import local nerezolvat „' + request + '”.' };
  const rel = normalizePath(path.relative(root, absolute));
  if (!rel || rel === '..' || rel.startsWith('../')) return { error: from + ': import in afara surselor „' + request + '”.' };
  return { path: rel };
}

function localImports(root, rel, errors) {
  let source;
  try { source = fs.readFileSync(path.join(root, rel), 'utf8'); }
  catch (error) { errors.push(rel + ': ' + error.message); return []; }
  const found = new Set();
  const patterns = [
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const resolved = resolveLocal(root, rel, match[1]);
      if (resolved && resolved.error) errors.push(resolved.error);
      else if (resolved) found.add(resolved.path);
    }
  }
  const dynamicRequire = /\brequire\s*\(([^)]*)\)/g; let call;
  while ((call = dynamicRequire.exec(source))) {
    if (!/^\s*['"][^'"]+['"]\s*$/.test(call[1])) {
      errors.push(rel + ': require dinamic nu poate fi inclus sigur in graful fiscal.');
    }
  }
  return [...found].sort();
}

function sourceHash(root, rel, known, errors) {
  const fromManifest = known.get(rel);
  if (fromManifest) return fromManifest;
  try { return sha(fs.readFileSync(path.join(root, rel))); }
  catch (error) { errors.push(rel + ': ' + error.message); return 'UNREADABLE'; }
}

function componentSource(root, id, errors) {
  const range = COMPONENT_RANGES[id];
  if (!range) { errors.push('Componenta fiscala necunoscuta: ' + id + '.'); return ''; }
  let source = '';
  try { source = fs.readFileSync(path.join(root, 'src/fiscal.js'), 'utf8'); }
  catch (error) { errors.push('src/fiscal.js: ' + error.message); return ''; }
  const start = source.indexOf(range[0]); const end = source.indexOf(range[1], start + range[0].length);
  if (start < 0 || end < 0 || end <= start) {
    errors.push('Limitele componentei ' + id + ' nu mai pot fi gasite in src/fiscal.js.'); return '';
  }
  return source.slice(start, end);
}

function treatmentEngineSource(root, errors) {
  let source = '';
  try { source = fs.readFileSync(path.join(root, 'src/fiscalTreatments.js'), 'utf8'); }
  catch (error) { errors.push('src/fiscalTreatments.js: ' + error.message); return ''; }
  const start = source.indexOf('const DEFINITIONS = [');
  const marker = '].map(normalize);'; const end = source.indexOf(marker, start);
  if (start < 0 || end < 0) {
    errors.push('Registrul tratamentelor nu mai are limite semantice verificabile.'); return '';
  }
  // Definitia fiecarei reguli este acoperita separat de hash-ul ei. Restul este motor comun.
  return source.slice(0, start) + 'const DEFINITIONS = <SCOPED_RULE_NODES>;' + source.slice(end + marker.length);
}

function snapshotValues(context) {
  const values = context && context.rules && context.rules.values;
  return values && typeof values === 'object' ? values : {};
}

function build(meta, context, options) {
  const o = options || {}; const root = path.resolve(o.root || (context && context.root) || ROOT);
  const spec = meta && meta.dependencies || {}; const errors = [];
  const nodes = new Map(); const edges = new Set(); const known = manifestHashes(context && context.manifest);
  const values = snapshotValues(context); const ruleSets = Array.isArray(values.ruleSets) ? values.ruleSets : [];
  const config = values.config && typeof values.config === 'object' ? values.config : {};

  function addNode(id, type, value, details) {
    const node = Object.assign({ id, type, hash: sha(stableJson(value)) }, details || {});
    const existing = nodes.get(id);
    if (existing && existing.hash !== node.hash) errors.push('Nodul ' + id + ' are doua versiuni incompatibile.');
    else nodes.set(id, node);
    return id;
  }
  function edge(from, to) { edges.add(from + '\u0000' + to); }

  const rootId = addNode('case:' + String(meta && meta.id || ''), 'case', {
    id: meta && meta.id, definitionHash: meta && meta.definitionHash,
  });
  const graphEngine = addNode('engine:fiscal-dependency-graph', 'engine', {
    schemaVersion: GRAPH_SCHEMA, source: sourceHash(root, 'src/fiscalDependencyGraph.js', known, errors),
  });
  edge(rootId, graphEngine);

  const selectedRuleSets = [];
  for (const id of spec.ruleSetIds || []) {
    const row = ruleSets.find((candidate) => candidate.id === id);
    if (!row) errors.push('FiscalRuleSet lipsa din fotografia runtime: ' + id + '.');
    else selectedRuleSets.push(row);
  }

  const parameterNodes = [];
  for (const ruleSet of selectedRuleSets) {
    for (const name of spec.rateNames || []) {
      const value = ruleSet.rates && ruleSet.rates[name];
      if (!Number.isFinite(Number(value))) {
        errors.push(ruleSet.id + ': parametrul fiscal lipseste sau nu este numeric: ' + name + '.'); continue;
      }
      const id = addNode('parameter:' + ruleSet.id + ':' + name, 'parameter', {
        name, value: Number(value), ruleSet: { id: ruleSet.id, validFrom: ruleSet.validFrom,
          validTo: ruleSet.validTo, publishedAt: ruleSet.publishedAt, approvalId: ruleSet.approvalId || null },
      }, { name, value: Number(value), ruleSetId: ruleSet.id, validFrom: ruleSet.validFrom,
        validTo: ruleSet.validTo, publishedAt: ruleSet.publishedAt, approvalId: ruleSet.approvalId || null });
      parameterNodes.push(id); edge(rootId, id);
    }
  }

  const configNodes = [];
  for (const selector of spec.configPaths || []) {
    if (!Object.prototype.hasOwnProperty.call(config, selector)) {
      errors.push('Selector de configuratie fiscala lipsa: ' + selector + '.'); continue;
    }
    const id = addNode('config:' + selector, 'configuration', { selector, value: config[selector] }, { selector });
    configNodes.push(id); edge(rootId, id);
  }

  const ruleNodes = [];
  for (const ruleSet of selectedRuleSets) {
    for (const ruleId of spec.ruleIds || []) {
      const rule = (ruleSet.treatments || []).find((candidate) => candidate.id === ruleId);
      if (!rule || !/^[0-9a-f]{64}$/.test(String(rule.hash || ''))) {
        errors.push(ruleSet.id + ': tratamentul lipseste sau nu are hash valid: ' + ruleId + '.'); continue;
      }
      const id = addNode('rule:' + ruleSet.id + ':' + ruleId, 'rule', {
        id: rule.id, hash: rule.hash, validFrom: rule.validFrom, validTo: rule.validTo,
        ruleSet: { id: ruleSet.id, validFrom: ruleSet.validFrom, validTo: ruleSet.validTo,
          publishedAt: ruleSet.publishedAt, approvalId: ruleSet.approvalId || null },
      }, { ruleId, ruleHash: rule.hash, ruleSetId: ruleSet.id,
        validFrom: rule.validFrom, validTo: rule.validTo, ruleSetValidFrom: ruleSet.validFrom,
        ruleSetValidTo: ruleSet.validTo, publishedAt: ruleSet.publishedAt,
        approvalId: ruleSet.approvalId || null });
      ruleNodes.push(id); edge(rootId, id);
    }
  }

  const componentNodes = new Map();
  function addComponent(component) {
    if (componentNodes.has(component)) return componentNodes.get(component);
    const id = addNode('component:' + component, 'component', { id: component,
      source: sha(componentSource(root, component, errors)) }, { component });
    componentNodes.set(component, id);
    for (const dependency of [...parameterNodes, ...configNodes, ...ruleNodes]) edge(id, dependency);
    return id;
  }

  const treatmentEngineId = addNode('engine:fiscal-treatments', 'engine', {
    source: sha(treatmentEngineSource(root, errors)),
  });
  if (ruleNodes.length) {
    edge(rootId, treatmentEngineId);
    for (const id of ruleNodes) edge(treatmentEngineId, id);
  }

  const visited = new Set();
  function visit(rel, parent) {
    const normalized = normalizePath(rel);
    if (normalized === 'src/fiscalConfig.js') {
      for (const id of [...parameterNodes, ...configNodes]) edge(parent, id);
      return;
    }
    if (normalized === 'src/fiscal.js') {
      const engine = addComponent('fiscal.engine'); edge(parent, engine);
      const registry = addComponent('fiscal.registry'); edge(engine, registry);
      for (const component of spec.components || []) edge(registry, addComponent(component));
      return;
    }
    if (normalized === 'src/fiscalTreatments.js') {
      edge(parent, treatmentEngineId);
      for (const id of ruleNodes) edge(treatmentEngineId, id);
      return;
    }
    const fileId = 'file:' + normalized;
    if (!nodes.has(fileId)) addNode(fileId, 'file', { path: normalized,
      sha256: sourceHash(root, normalized, known, errors) }, { path: normalized });
    edge(parent, fileId);
    if (visited.has(normalized)) return;
    visited.add(normalized);
    for (const imported of localImports(root, normalized, errors)) visit(imported, fileId);
  }

  for (const file of spec.files || []) visit(file, rootId);
  for (const component of spec.components || []) edge(rootId, addComponent(component));

  // SPECIAL_FILES exista ca lista inchisa pentru ca un nou fisier monolitic sa nu poata fi
  // tratat accidental ca nod semantic fara implementarea corespunzatoare.
  for (const file of spec.files || []) {
    if (String(file).startsWith('src/fiscal') && !SPECIAL_FILES.has(normalizePath(file))
        && normalizePath(file) !== 'src/fiscalRules.js') {
      errors.push('Fisier fiscal special fara strategie de segmentare: ' + file + '.');
    }
  }

  const publicNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const publicEdges = [...edges].sort().map((value) => {
    const parts = value.split('\u0000'); return { from: parts[0], to: parts[1] };
  });
  const consumers = [...new Set(spec.consumers || [])].sort();
  const rootHash = sha(stableJson({ schemaVersion: GRAPH_SCHEMA,
    nodes: publicNodes.map((node) => ({ id: node.id, hash: node.hash })), edges: publicEdges }));
  return { schemaVersion: GRAPH_SCHEMA, caseId: meta && meta.id, rootHash, errors: [...new Set(errors)].sort(),
    consumers, nodes: publicNodes, edges: publicEdges };
}

module.exports = { GRAPH_SCHEMA, build, stableJson };
