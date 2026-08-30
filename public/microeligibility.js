'use strict';

// Editorul registrului micro foloseste campuri contabile explicite, nu un textarea JSON. Serverul
// normalizeaza si valideaza din nou totul; aici doar transformam randurile lizibile in payload.

let deps = {};
let current = null;
const q = (s) => document.querySelector(s);
const esc = (v) => deps.H ? deps.H(v == null ? '' : v) : String(v == null ? '' : v);
const todayPeriod = () => new Date().toISOString().slice(0, 7);
const endOfMonth = (p) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0)).toISOString().slice(0, 10);
const rid = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

function lines(rows, fields) {
  return (rows || []).map((row) => fields.map((field) => row[field] == null ? '' : row[field]).join(' | ')).join('\n');
}
function parseLines(value, fields) {
  return String(value || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((row) => {
    const values = row.split('|').map((x) => x.trim()); const out = {};
    fields.forEach((field, index) => { out[field] = field === 'amount' ? Number(values[index]) : (values[index] || ''); });
    return out;
  });
}
function field(row, name) { return row.querySelector('[data-field="' + name + '"]'); }
function value(row, name) { const el = field(row, name); return el ? el.value : ''; }
function checked(row, name) { const el = field(row, name); return !!(el && el.checked); }
function removeButtons(container, render) {
  container.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => {
    // Pastreaza editarile nesalvate din celelalte randuri inainte de rerandare.
    syncRegistry();
    current.registry[button.dataset.remove].splice(Number(button.dataset.index), 1); render();
  }));
}

function associateRow(a, index) {
  return `<div class="card micro-reg-row" data-index="${index}"><div class="dyn">
    <input type="hidden" data-field="id" value="${esc(a.id)}">
    <label>Nume <input data-field="name" value="${esc(a.name)}"></label>
    <label>CNP/CUI/identificator <input data-field="identifier" value="${esc(a.identifier)}"></label>
    <label>Tip <select data-field="kind"><option value="person" ${a.kind !== 'company' ? 'selected' : ''}>Persoană</option><option value="company" ${a.kind === 'company' ? 'selected' : ''}>Societate</option></select></label>
    <label>Țintă în graf <input data-field="targetId" value="${esc(a.targetId || 'self')}"></label>
    <label>Participație % <input data-field="ownershipPercent" type="number" min="0" max="100" step="0.01" value="${esc(a.ownershipPercent || 0)}"></label>
    <label>Drepturi de vot % <input data-field="votingPercent" type="number" min="0" max="100" step="0.01" value="${esc(a.votingPercent || 0)}"></label>
    <label>Valabil de la <input data-field="validFrom" type="date" value="${esc(a.validFrom)}"></label>
    <label>Valabil până la <input data-field="validTo" type="date" value="${esc(a.validTo)}"></label>
    <label class="full">Document <input data-field="evidenceReference" value="${esc(a.evidenceReference)}"></label>
  </div><button type="button" class="btn small danger" data-remove="associates" data-index="${index}">Șterge</button></div>`;
}
function readAssociates() {
  return [...q('#microAssociates').querySelectorAll('.micro-reg-row')].map((row) => ({
    id: value(row, 'id'), name: value(row, 'name'), identifier: value(row, 'identifier'), kind: value(row, 'kind'),
    targetId: value(row, 'targetId') || 'self', ownershipPercent: Number(value(row, 'ownershipPercent')),
    votingPercent: Number(value(row, 'votingPercent')), validFrom: value(row, 'validFrom'),
    validTo: value(row, 'validTo'), evidenceReference: value(row, 'evidenceReference'),
  }));
}
function renderAssociates() {
  const box = q('#microAssociates'); box.innerHTML = current.registry.associates.map(associateRow).join('')
    || '<p class="muted">Nicio participație. Acoperirea de mai sus confirmă explicit că registrul a fost verificat.</p>';
  removeButtons(box, renderAssociates);
}

function linkedRow(e, index) {
  return `<div class="card micro-reg-row" data-index="${index}"><div class="dyn">
    <input type="hidden" data-field="id" value="${esc(e.id)}">
    <label>Denumire <input data-field="name" value="${esc(e.name)}"></label><label>CUI <input data-field="cui" value="${esc(e.cui)}"></label>
    <label>Tip <select data-field="kind"><option value="company" ${e.kind === 'company' ? 'selected' : ''}>Societate</option><option value="pfa_actual" ${e.kind === 'pfa_actual' ? 'selected' : ''}>PFA — sistem real</option><option value="pfa_norm" ${e.kind === 'pfa_norm' ? 'selected' : ''}>PFA — normă</option></select></label>
    <label>Temei legătură <select data-field="relation">${[['ownership','Participație'],['voting','Vot'],['control','Control'],['common_control','Control comun'],['management','Conducere'],['family_economic','Familie + activitate economică']].map(([v,l]) => `<option value="${v}" ${e.relation === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Părinte în graf <input data-field="parentId" value="${esc(e.parentId || 'self')}"></label>
    <label>Participație % <input data-field="ownershipPercent" type="number" min="0" max="100" step="0.01" value="${esc(e.ownershipPercent || 0)}"></label>
    <label>Vot % <input data-field="votingPercent" type="number" min="0" max="100" step="0.01" value="${esc(e.votingPercent || 0)}"></label>
    <label class="check"><input data-field="control" type="checkbox" ${e.control ? 'checked' : ''}> Control efectiv</label>
    <label>Legată de la <input data-field="validFrom" type="date" value="${esc(e.validFrom)}"></label><label>Legată până la <input data-field="validTo" type="date" value="${esc(e.validTo)}"></label>
    <label>Venituri acoperite de la <input data-field="revenueCoverageFrom" type="date" value="${esc(e.revenueCoverageFrom)}"></label><label>Complete până la <input data-field="revenueCompleteThrough" type="date" value="${esc(e.revenueCompleteThrough)}"></label>
    <label class="full">Norme anuale PFA <textarea data-field="annualNorms" rows="2" placeholder="2025 | 60000 | decizie normă 2025&#10;2026 | 65000 | decizie normă 2026">${esc(lines(e.annualNorms, ['year','amount','source']))}</textarea></label>
    <label class="full">Cifra de afaceri / venituri cronologice — valori incrementale, nu total cumulat <textarea data-field="revenues" rows="3" placeholder="2026-01-31 | 25000 | rulajul lunii ianuarie">${esc(lines(e.revenues, ['date','amount','source']))}</textarea></label>
    <label class="full">Documentul legăturii <input data-field="evidenceReference" value="${esc(e.evidenceReference)}"></label>
  </div><button type="button" class="btn small danger" data-remove="linkedEnterprises" data-index="${index}">Șterge</button></div>`;
}
function readLinked() {
  return [...q('#microLinked').querySelectorAll('.micro-reg-row')].map((row) => ({
    id: value(row, 'id'), name: value(row, 'name'), cui: value(row, 'cui'), kind: value(row, 'kind'),
    relation: value(row, 'relation'), parentId: value(row, 'parentId') || 'self',
    ownershipPercent: Number(value(row, 'ownershipPercent')), votingPercent: Number(value(row, 'votingPercent')),
    control: checked(row, 'control'), validFrom: value(row, 'validFrom'), validTo: value(row, 'validTo'),
    revenueCoverageFrom: value(row, 'revenueCoverageFrom'), revenueCompleteThrough: value(row, 'revenueCompleteThrough'),
    annualNorms: parseLines(value(row, 'annualNorms'), ['year','amount','source']),
    revenues: parseLines(value(row, 'revenues'), ['date','amount','source']),
    evidenceReference: value(row, 'evidenceReference'),
  }));
}
function renderLinked() {
  const box = q('#microLinked'); box.innerHTML = current.registry.linkedEnterprises.map(linkedRow).join('')
    || '<p class="muted">Nicio întreprindere legată declarată pentru perioada confirmată.</p>';
  removeButtons(box, renderLinked);
}

function workforceRow(w, index) {
  return `<div class="card micro-reg-row" data-index="${index}"><div class="dyn">
    <input type="hidden" data-field="id" value="${esc(w.id)}"><label>Persoană / rol <input data-field="person" value="${esc(w.person)}"></label>
    <label>Tip <select data-field="kind"><option value="employment" ${w.kind === 'employment' ? 'selected' : ''}>Contract de muncă</option><option value="mandate" ${w.kind === 'mandate' ? 'selected' : ''}>Administrare / mandat</option></select></label>
    <label>FTE <input data-field="fte" type="number" min="0.01" max="1" step="0.01" value="${esc(w.fte || 1)}"></label>
    <label>Remunerație mandat/lună <input data-field="remunerationMonthly" type="number" min="0" step="0.01" value="${esc(w.remunerationMonthly || 0)}"></label>
    <label class="check"><input data-field="indefinite" type="checkbox" ${w.indefinite ? 'checked' : ''}> CIM nedeterminat</label>
    <label>De la <input data-field="validFrom" type="date" value="${esc(w.validFrom)}"></label><label>Până la <input data-field="validTo" type="date" value="${esc(w.validTo)}"></label>
    <label class="full">Suspendări <textarea data-field="suspensions" rows="3" placeholder="2026-02-01 | 2026-02-10 | medical | certificat CM">${esc(lines(w.suspensions, ['from','to','kind','evidenceReference']))}</textarea></label>
    <label class="full">Document CIM / mandat <input data-field="evidenceReference" value="${esc(w.evidenceReference)}"></label>
  </div><button type="button" class="btn small danger" data-remove="workforce" data-index="${index}">Șterge</button></div>`;
}
function readWorkforce() {
  return [...q('#microWorkforce').querySelectorAll('.micro-reg-row')].map((row) => ({
    id: value(row, 'id'), person: value(row, 'person'), kind: value(row, 'kind'), fte: Number(value(row, 'fte')),
    remunerationMonthly: Number(value(row, 'remunerationMonthly')), indefinite: checked(row, 'indefinite'),
    validFrom: value(row, 'validFrom'), validTo: value(row, 'validTo'),
    suspensions: parseLines(value(row, 'suspensions'), ['from','to','kind','evidenceReference']),
    evidenceReference: value(row, 'evidenceReference'),
  }));
}
function renderWorkforce() {
  const box = q('#microWorkforce'); box.innerHTML = current.registry.workforce.map(workforceRow).join('')
    || '<p class="muted">Niciun CIM sau mandat documentat. Lista de salarizare nu înlocuiește acest registru datat.</p>';
  removeButtons(box, renderWorkforce);
}

function assetRow(a, index) {
  return `<div class="row micro-reg-row" data-index="${index}"><input data-field="entryId" placeholder="ID articol" value="${esc(a.entryId)}"><select data-field="kind"><option value="fixed_asset" ${a.kind !== 'land' ? 'selected' : ''}>Mijloc fix</option><option value="land" ${a.kind === 'land' ? 'selected' : ''}>Teren</option></select><input data-field="group" placeholder="subgrupa Catalog (doar mijloc fix)" value="${esc(a.group)}"><input class="grow" data-field="evidenceReference" placeholder="document" value="${esc(a.evidenceReference)}"><button type="button" class="btn small danger" data-remove="assetTransfers" data-index="${index}">Șterge</button></div>`;
}
function readAssets() { return [...q('#microAssets').querySelectorAll('.micro-reg-row')].map((row) => ({ entryId: value(row, 'entryId'), kind: value(row, 'kind'), group: value(row, 'group'), evidenceReference: value(row, 'evidenceReference') })); }
function renderAssets() { const box = q('#microAssets'); box.innerHTML = current.registry.assetTransfers.map(assetRow).join('') || '<p class="muted">Nicio clasificare.</p>'; removeButtons(box, renderAssets); }

function blankRegistry(period) {
  const through = endOfMonth(period);
  return { version: 1, registrationDate: '', ownershipCompleteThrough: through,
    workforceCompleteThrough: through, evidenceReference: '', associates: [], linkedEnterprises: [], workforce: [], assetTransfers: [] };
}
function renderStatus(assessment) {
  const box = q('#microEligibilityStatus');
  const icon = assessment.status === 'eligible' ? '✅' : assessment.status === 'profit_required' ? '⛔' : '⚠️';
  const title = assessment.status === 'eligible' ? 'Eligibilitate susținută de registru'
    : assessment.status === 'profit_required' ? 'Trecere obligatorie la impozit pe profit' : 'Registru incomplet — D100/D101 blocate';
  const problems = [...(assessment.blockers || []).map((x) => x.message), ...(assessment.warnings || [])];
  const crossing = assessment.crossing ? '<br>Operațiunea care depășește: <b>' + esc(assessment.crossing.date)
    + '</b> · ' + deps.fmt(assessment.crossing.totalBefore) + ' → ' + deps.fmt(assessment.crossing.totalAfter) + ' lei.' : '';
  const opening = assessment.opening && assessment.opening.crossing
    ? '<br>La 31.12.' + esc(assessment.opening.year) + ': <b>' + deps.fmt(assessment.opening.combinedRevenue)
      + ' lei</b>; operațiunea depășirii: ' + esc(assessment.opening.crossing.date) + '.' : '';
  const workforce = assessment.workforce && assessment.workforce.qualifies != null
    ? '<br>Personal: <b>' + (assessment.workforce.qualifies ? 'condiție îndeplinită' : 'condiție pierdută')
      + '</b>' + (assessment.workforce.fteAtEnd != null ? ' · FTE ' + esc(assessment.workforce.fteAtEnd) : '') + '.' : '';
  box.innerHTML = `<span class="ei">${icon}</span><p><b>${esc(title)}</b><br>Cifră proprie: <b>${deps.fmt(assessment.ownRevenue)}</b> lei · legate: <b>${deps.fmt(assessment.linkedRevenue)}</b> lei · total: <b>${deps.fmt(assessment.combinedRevenue)}</b> / ${deps.fmt(assessment.thresholdLei)} lei.${assessment.exit ? '<br>Ieșire determinată: <b>' + esc(assessment.exit.period) + '</b>.' : ''}${opening}${crossing}${workforce}${problems.length ? '<br><span class="muted">' + problems.map(esc).join(' ') + '</span>' : ''}</p>`;
}
function renderGraph(graph) {
  const box = q('#microEligibilityGraph'); if (!box) return;
  const nodes = new Map(((graph || {}).nodes || []).map((node) => [node.id, node.label || node.id]));
  const edges = (graph || {}).edges || [];
  box.innerHTML = edges.length ? `<table><thead><tr><th>De la</th><th>Către</th><th>Relație</th><th>Participație / vot</th><th>Perioadă</th></tr></thead><tbody>${edges.map((edge) => `<tr><td>${esc(nodes.get(edge.from) || edge.from)}</td><td>${esc(nodes.get(edge.to) || edge.to)}</td><td>${esc(edge.relation)}</td><td>${esc(edge.ownershipPercent || 0)}% / ${esc(edge.votingPercent || 0)}%</td><td>${esc(edge.validFrom)} → ${esc(edge.validTo || 'prezent')}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nu sunt legături în graficul reviziei salvate.</p>';
}
function renderHistory(rows) {
  q('#microEligibilityHistory').innerHTML = rows.length ? `<table><thead><tr><th>Înregistrată</th><th>Motiv</th><th>Actor</th><th>SHA-256</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${esc(String(x.recordedAt || '').replace('T',' ').slice(0,16))} UTC</td><td>${esc(x.reason)}</td><td>${esc(x.recordedByName || x.recordedBy || 'sistem')}</td><td><code>${esc(String(x.hash || '').slice(0,16))}…</code></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nicio revizie salvată.</p>';
}
function renderAll() {
  const r = current.registry;
  q('#microRegistrationDate').value = r.registrationDate || '';
  q('#microOwnershipThrough').value = r.ownershipCompleteThrough || '';
  q('#microWorkforceThrough').value = r.workforceCompleteThrough || '';
  q('#microRegistryEvidence').value = r.evidenceReference || '';
  renderAssociates(); renderLinked(); renderWorkforce(); renderAssets(); renderGraph(current.assessment.graph);
  renderStatus(current.assessment); renderHistory(current.history || []);
}

function syncRegistry() {
  current.registry = Object.assign({}, current.registry, {
    version: 1, registrationDate: q('#microRegistrationDate').value,
    ownershipCompleteThrough: q('#microOwnershipThrough').value,
    workforceCompleteThrough: q('#microWorkforceThrough').value,
    evidenceReference: q('#microRegistryEvidence').value,
    associates: readAssociates(), linkedEnterprises: readLinked(), workforce: readWorkforce(), assetTransfers: readAssets(),
  });
}

export async function loadMicroEligibility() {
  const card = q('#microEligibilityCard'); if (!card || !deps.api) return;
  const period = q('#microEligibilityPeriod'); if (!period.value) period.value = todayPeriod();
  try {
    const data = await deps.api('/api/fiscal/micro/eligibility?period=' + encodeURIComponent(period.value));
    current = data; current.registry = current.registry || blankRegistry(period.value); renderAll();
  } catch (error) { q('#microEligibilityStatus').innerHTML = '<span class="ei">⛔</span><p>' + esc(error.message) + '</p>'; }
}

export function setMicroEligibilityDeps(value) {
  deps = value || {};
  q('#microEligibilityPeriod')?.addEventListener('change', loadMicroEligibility);
  q('#microAddAssociate')?.addEventListener('click', () => { syncRegistry(); current.registry.associates.push({ id: rid('associate'), kind: 'person', targetId: 'self', ownershipPercent: 0, votingPercent: 0, validFrom: current.assessment.year + '-01-01', validTo: '', evidenceReference: '' }); renderAssociates(); });
  q('#microAddLinked')?.addEventListener('click', () => { syncRegistry(); current.registry.linkedEnterprises.push({ id: rid('linked'), kind: 'company', relation: 'ownership', parentId: 'self', ownershipPercent: 0, votingPercent: 0, validFrom: current.assessment.year + '-01-01', validTo: '', revenueCoverageFrom: current.assessment.year + '-01-01', revenueCompleteThrough: endOfMonth(q('#microEligibilityPeriod').value), annualNorms: [], revenues: [], evidenceReference: '' }); renderLinked(); });
  q('#microAddWorkforce')?.addEventListener('click', () => { syncRegistry(); current.registry.workforce.push({ id: rid('workforce'), kind: 'employment', fte: 1, remunerationMonthly: 0, indefinite: true, durationMonths: 0, validFrom: current.assessment.year + '-01-01', validTo: '', suspensions: [], evidenceReference: '' }); renderWorkforce(); });
  q('#microAddAsset')?.addEventListener('click', () => { syncRegistry(); current.registry.assetTransfers.push({ entryId: '', kind: 'fixed_asset', group: '', evidenceReference: '' }); renderAssets(); });
  q('#microEligibilitySave')?.addEventListener('click', async () => {
    try {
      syncRegistry(); const reason = q('#microRevisionReason').value.trim();
      await deps.api('/api/fiscal/micro/eligibility', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ when: q('#microEligibilityPeriod').value, reason, registry: current.registry }) });
      q('#microRevisionReason').value = ''; deps.toast('Registrul micro a fost versionat și recalculat.');
      await loadMicroEligibility();
    } catch (error) { deps.toast(error.message, true); }
  });
}
