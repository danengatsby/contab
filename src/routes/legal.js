'use strict';

// Acceptari juridice si configurarea transmiterii catre AI, per firma. Nicio acceptare nu se
// deduce din simpla folosire a aplicatiei: fiecare act produce o inregistrare versionata si audit.

const db = require('../db');
const legal = require('../legalCompliance');
const ai = require('../aiExtractor');
const { isDemoUser } = require('../session');

function fail(status, message, code) {
  const e = new Error(message); e.status = status; e.code = code; throw e;
}

function canManage(user, firma) {
  return !!(user && firma && (user.role === 'admin' || Number(firma.ownerId) === Number(user.id)));
}

module.exports = function register(app, ctx) {
  const { activeId, logAudit } = ctx;

  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
    }
  };

  // Public: formularul de inscriere si paginile juridice pot arata versiunile curente inainte
  // sa existe o sesiune. Nu expunem continut operational sau secrete; doar starea de lansare.
  app.get('/api/legal-status', (req, res) => res.json(legal.publicStatus()));

  app.get('/api/legal', (req, res) => {
    const firma = db.getFirma(activeId(req));
    const launch = legal.publicStatus();
    const state = legal.firmState(firma);
    res.json({
      launch,
      firm: firma ? {
        id: firma.id,
        mode: state.mode,
        operational: state.operational,
        reason: state.reason,
        acceptanceCurrent: state.acceptanceCurrent,
        canManage: canManage(req.user, firma) && !isDemoUser(req.user),
        acceptedAt: firma.legalAcceptance && firma.legalAcceptance.acceptedAt || null,
      } : null,
      ai: firma ? {
        enabled: legal.aiAllowed(firma),
        requested: !!(firma.aiProcessing && firma.aiProcessing.enabled),
        consentCurrent: !!(firma.aiProcessing && legal.acceptanceCurrent(firma.aiProcessing.consent, 'ai-processing')),
        consentAt: firma.aiProcessing && firma.aiProcessing.consent && firma.aiProcessing.consent.acceptedAt || null,
        provider: ai.resolveProvider(),
      } : null,
    });
  });

  app.post('/api/legal/mode', (req, res) => run(res, () => {
    const firma = db.getFirma(activeId(req));
    if (!firma) fail(404, 'Nu există o firmă activă.', 'NO_ACTIVE_COMPANY');
    if (!canManage(req.user, firma) || isDemoUser(req.user)) {
      fail(403, 'Numai proprietarul firmei poate declara regimul datelor și accepta DPA-ul.', 'LEGAL_OWNER_REQUIRED');
    }
    const body = req.body || {};
    const mode = String(body.mode || '');
    if (mode === 'test') {
      if (body.confirmFictitious !== true) {
        fail(400, 'Confirmă explicit că firma va folosi exclusiv date fictive.', 'TEST_DATA_CONFIRMATION_REQUIRED');
      }
      firma.dataMode = 'test';
      firma.legalAcceptance = legal.acceptanceRecord('test-data', req.user, { declaration: 'fictitious-only' });
      // Schimbarea regimului revoca opt-in-ul AI: destinatarul extern trebuie reconfirmat separat.
      firma.aiProcessing = Object.assign({}, firma.aiProcessing, {
        enabled: false, revokedAt: new Date().toISOString(), revokedBy: req.user.id,
      });
      db.save();
      logAudit('legal.mode.test', 'exclusiv date fictive · versiuni ' + JSON.stringify(firma.legalAcceptance.versions), { req });
      return { ok: true, mode: 'test', operational: true };
    }
    if (mode !== 'real') fail(400, 'Regimul trebuie să fie „test” sau „real”.', 'LEGAL_MODE_INVALID');

    const launch = legal.assess();
    if (!launch.ready) {
      fail(503, 'Datele reale rămân blocate: identitatea furnizorului sau dosarul GDPR nu este complet.', 'LEGAL_READINESS_INCOMPLETE');
    }
    if (body.acceptTerms !== true || body.acceptPrivacy !== true || body.acceptDpa !== true) {
      fail(400, 'Acceptă explicit Termenii, Politica de confidențialitate și DPA-ul curent.', 'LEGAL_ACCEPTANCE_REQUIRED');
    }
    firma.dataMode = 'real';
    firma.legalAcceptance = legal.acceptanceRecord('real-data', req.user, {
      controllerDeclaration: true,
      providerTaxId: launch.provider.taxId,
    });
    firma.aiProcessing = Object.assign({}, firma.aiProcessing, {
      enabled: false, revokedAt: new Date().toISOString(), revokedBy: req.user.id,
    });
    db.save();
    logAudit('legal.mode.real', 'DPA acceptat explicit · versiuni ' + JSON.stringify(firma.legalAcceptance.versions), { req });
    return { ok: true, mode: 'real', operational: true, acceptedAt: firma.legalAcceptance.acceptedAt };
  }));

  app.post('/api/legal/ai', (req, res) => run(res, () => {
    const firma = db.getFirma(activeId(req));
    if (!firma) fail(404, 'Nu există o firmă activă.', 'NO_ACTIVE_COMPANY');
    if (!canManage(req.user, firma) || isDemoUser(req.user)) {
      fail(403, 'Numai proprietarul firmei poate decide transmiterea documentelor către AI.', 'LEGAL_OWNER_REQUIRED');
    }
    const enabled = (req.body || {}).enabled;
    if (typeof enabled !== 'boolean') fail(400, 'Alege explicit dacă transmiți documente către AI.', 'AI_CHOICE_REQUIRED');
    firma.aiProcessing = firma.aiProcessing || {};
    if (!enabled) {
      firma.aiProcessing.enabled = false;
      firma.aiProcessing.revokedAt = new Date().toISOString();
      firma.aiProcessing.revokedBy = req.user.id;
      db.save();
      logAudit('legal.ai.revoked', 'transmiterea documentelor către AI a fost oprită', { req });
      return { ok: true, enabled: false };
    }
    const state = legal.firmState(firma);
    if (!state.operational) fail(428, 'Declară mai întâi regimul datelor firmei.', state.reason);
    if ((req.body || {}).confirmExternalProcessing !== true) {
      fail(400, 'Confirmă explicit transmiterea documentelor către furnizorul AI afișat.', 'AI_CONSENT_REQUIRED');
    }
    const provider = ai.resolveProvider();
    if (provider.provider === 'none') fail(503, 'Nu este configurat niciun furnizor AI.', 'AI_UNAVAILABLE');
    firma.aiProcessing = {
      enabled: true,
      consent: legal.acceptanceRecord('ai-processing', req.user, {
        provider: provider.provider,
        model: provider.model,
        purpose: 'document-field-extraction',
        firmMode: state.mode,
      }),
    };
    db.save();
    logAudit('legal.ai.accepted', provider.provider + '/' + provider.model + ' · extragere câmpuri document', { req });
    return { ok: true, enabled: true, provider };
  }));
};
