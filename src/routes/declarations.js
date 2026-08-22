'use strict';

// Rutele registrului depunerilor, portofoliului si notificarilor de termene.
// Modul de rute: `register(app, ctx)` primeste app-ul Express + helperii partajati
// din server.js (context injectat), ca sa nu duplice starea globala.

const decl = require('../declarations');
const plans = require('../plans');
const rep = require('../reporting');
const acc = require('../accounting');
const ptOpts = require('../profitTaxOptions');
const d107 = require('../d107');
const d301 = require('../d301');
const d307 = require('../d307');
const d311 = require('../d311');
const { statPlataPostata } = require('../payroll');

module.exports = function register(app, ctx) {
  const { db, S, activeId, allowedFirme, logAudit } = ctx;

  app.get('/api/declarations', (req, res) => {
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
    res.json({ period, rows: decl.registerForFirma(db.get(), S(req), period) });
  });

  // ── Declaratii rectificative ────────────────────────────────────────────
  // Cifrele-cheie ale unei depuneri, ca sa se poata arata DIFERENTA la rectificativa. Fara ele,
  // istoricul ar spune „s-a mai depus o data", fara sa spuna CE s-a schimbat.
  function sumeCheie(view, tip, period) {
    try {
      if (tip === 'd300') { const x = rep.d300(view, period); return { tvaColectata: x.tvaColectata, tvaDeductibila: x.tvaDeductibila, tvaDePlata: x.tvaDePlata, tvaDeRecuperat: x.tvaDeRecuperat }; }
      if (tip === 'd301') { const x = d301.report(view, period); return { baza: x.totalBaza, tvaDePlata: x.totalTva }; }
      if (tip === 'd307') { const x = d307.report(view, period); return { tvaA: x.totaluri.A, tvaL: x.totaluri.L, tvaC: x.totaluri.C, total: x.totalTva }; }
      if (tip === 'd311') { const x = d311.report(view, period); return { baza: x.totalBaza, tvaDePlata: x.totalTva }; }
      if (tip === 'd107') { const year = period.slice(0, 4); const po = ptOpts.pentruDeclaratie(view, year); const pt = po.rezultatFiscal || acc.profitTax(view, year, po); const x = d107.report(view, year, pt); return { acordat: x.totals.val1, reportat: x.totals.val2, dedus: x.totals.val3, beneficiari: x.nr }; }
      if (tip === 'd205') { const x = rep.d205(view, period.slice(0, 4)); return { beneficiari: x.nr, venitBrut: x.totalBrut, bazaImpozabila: x.totalBaza, impozit: x.totalImpozit }; }
      if (tip === 'd112') {
        const t = statPlataPostata(view, period).totals;
        return { brut: t.brut, impozit: t.impozit,
          cas: (t.cas || 0) + (t.casAngajator || 0),
          cass: (t.cass || 0) + (t.cassAngajator || 0),
          cam: t.cam, totalBuget: t.totalBuget };
      }
      if (tip === 'd394') { const x = rep.d300(view, period); return { tvaColectata: x.tvaColectata, tvaDeductibila: x.tvaDeductibila }; }
      if (tip === 'd100') return decl.d100Snapshot(rep.d100(view, period));
    } catch (e) { /* raportul nu se poate calcula: istoricul ramane fara sume, nu pica depunerea */ }
    return null;
  }

  app.get('/api/declarations/istoric', (req, res) => {
    const { tip, period } = req.query;
    if (!decl.TIPURI[tip]) return res.status(400).json({ error: 'Tip de declaratie necunoscut.' });
    if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
    const rec = decl.find(db.get(), activeId(req), tip, period);
    const depuneri = (rec && rec.depuneri) || [];
    // Diferenta fata de ultima depunere, calculata pe datele DE ACUM: asta ar depune utilizatorul.
    const ultima = decl.lastSubmission(rec);
    const acum = { sume: sumeCheie(S(req), tip, period) };
    res.json({
      tip, period, depuneri,
      semnalizataInXml: !!decl.RECT_IN_XML[tip],
      diferenta: ultima ? decl.submissionDiff(ultima, acum) : [],
    });
  });

  app.post('/api/declarations/rectificativa', (req, res) => {
    const b = req.body || {};
    if (!decl.TIPURI[b.tip]) return res.status(400).json({ error: 'Tip de declaratie necunoscut.' });
    if (!/^\d{4}-\d{2}$/.test(String(b.period || ''))) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
    const d = db.get();
    const fid = activeId(req);
    const rec = decl.find(d, fid, b.tip, b.period);
    if (!rec || !decl.lastSubmission(rec)) {
      return res.status(400).json({ error: 'Nu exista o depunere anterioara pe ' + b.period + ': depune declaratia normal, nu rectificativ.' });
    }
    // Perioada inchisa NU blocheaza rectificativa — asta e chiar scopul ei — dar cere MOTIV SCRIS,
    // pe modelul fortarii inchiderii lunare. Fara motiv, corectia peste o luna deja raportata ar
    // fi invizibila la orice control ulterior.
    const firma = db.getFirma(fid) || {};
    const inchisa = firma.lockedUntil && String(b.period) <= String(firma.lockedUntil);
    const motiv = String(b.motiv || '').trim();
    const recipisa = String(b.recipisa || '').trim();
    if (inchisa && motiv.length < 5) {
      return res.status(400).json({ error: 'Perioada ' + b.period + ' este inchisa. Rectificativa e permisa, dar cere un motiv scris (minim 5 caractere).' });
    }
    if (recipisa.length < 2) {
      return res.status(400).json({ error: 'O rectificativa devine depusa numai cu numarul recipisei/indexul ANAF.' });
    }
    const r = decl.addSubmission(d, fid, b.tip, b.period, {
      motiv, de: req.user.username, tipRec: b.tipRec, recipisa,
      artifactHash: rec.artifactHash || '',
      sume: sumeCheie(S(req), b.tip, b.period),
    }, db.nextId);
    logAudit('declaratie.rectificativa', b.tip.toUpperCase() + ' ' + b.period
      + ' — depunerea #' + r.depunere.ordinal + (inchisa ? ' (perioada inchisa)' : '')
      + (motiv ? ': ' + motiv : ''), { req });
    db.save();
    res.json({ ok: true, depunere: r.depunere, depuneri: r.rec.depuneri, semnalizataInXml: !!decl.RECT_IN_XML[b.tip] });
  });

  app.post('/api/declarations/set', (req, res) => {
    const b = req.body || {};
    if (!decl.TIPURI[b.tip]) return res.status(400).json({ error: 'Tip de declaratie necunoscut.' });
    if (!/^\d{4}-\d{2}$/.test(String(b.period || ''))) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
    if (!decl.STATUSES.includes(b.status)) return res.status(400).json({ error: 'Stare invalida.' });
    const d = db.get();
    const fid = activeId(req);
    const existent = decl.find(d, fid, b.tip, b.period);
    const recipisa = String(b.recipisa || '').trim();
    const note = String(b.note || '').trim();
    if (existent && existent.status === 'depusa' && b.status !== 'depusa') {
      return res.status(409).json({ error: 'O declaratie depusa nu se retrogradeaza. Pentru corectie foloseste fluxul de rectificativa.' });
    }
    if (existent && existent.status === 'transmisa' && (b.status === 'generata' || b.status === 'nedepusa')) {
      return res.status(409).json({ error: 'O declaratie transmisa nu se retrogradeaza. Marcheaz-o depusa cu recipisa sau eroare cu explicatie.' });
    }
    if (existent && existent.status !== 'nedepusa' && b.status === 'nedepusa') {
      return res.status(409).json({ error: 'Starea nu se reseteaza la „nedepusa”; istoricul artefactului trebuie pastrat.' });
    }
    if (b.status === 'depusa' && recipisa.length < 2) {
      return res.status(400).json({ error: 'Starea „depusa” cere numarul recipisei/indexul primit de la ANAF.' });
    }
    if ((b.status === 'generata' || b.status === 'transmisa' || b.status === 'depusa') && !(existent && existent.artifactHash)) {
      return res.status(400).json({ error: 'Genereaza mai intai fisierul declaratiei; starea „' + b.status + '” trebuie legata de un artefact exact.' });
    }
    if ((b.status === 'eroare' || b.status === 'scutita') && note.length < 3) {
      return res.status(400).json({ error: 'Starea „' + b.status + '” cere o explicatie scurta.' });
    }
    decl.record(d, activeId(req), b.tip, b.period, {
      status: b.status, recipisa, note, updatedBy: req.user.username,
    }, db.nextId);
    // Marcarea „depusa" SEEDEAZA prima depunere in istoric. Fara asta cele doua mecanisme ar fi
    // deconectate: registrul ar sti ca declaratia e depusa, dar ruta de rectificativa n-ar gasi
    // nicio depunere anterioara si ar refuza corectia. Doar PRIMA — redepunerile trec prin
    // /api/declarations/rectificativa, care cere motiv pe perioada inchisa.
    if (b.status === 'depusa') {
      const recSet = decl.find(d, activeId(req), b.tip, b.period);
      if (!decl.lastSubmission(recSet)) {
        decl.addSubmission(d, activeId(req), b.tip, b.period, {
          de: req.user.username, recipisa, artifactHash: recSet.artifactHash || '',
          sume: sumeCheie(S(req), b.tip, b.period),
        }, db.nextId);
      }
    }
    logAudit('declaratie.status', b.tip.toUpperCase() + ' ' + b.period + ' → ' + b.status + (b.recipisa ? ' (recipisa ' + b.recipisa + ')' : ''), { req });
    // Declaratie DEPUSA => perioada se blocheaza automat (luna raportata nu se mai editeaza;
    // corectiile ulterioare se fac prin stornare in luna curenta). Deblocare: Setari -> Blocare perioada.
    let locked = null;
    if (b.status === 'depusa') {
      const firma = db.getFirma(activeId(req));
      if (firma && (!firma.lockedUntil || firma.lockedUntil < b.period)) {
        firma.lockedUntil = b.period;
        locked = b.period;
        logAudit('perioada.lock', 'blocata automat pana la ' + b.period + ' (' + b.tip.toUpperCase() + ' depusa)', { req });
      }
    }
    db.save();
    res.json({ ok: true, locked, rows: decl.registerForFirma(d, S(req), b.period) });
  });

  app.get('/api/portfolio', (req, res) => {
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
    const d = db.get();
    const fids = allowedFirme(req.user);
    const p = decl.portfolio(d, fids.map((id) => db.scoped(id)), period);
    // Imbogatire per firma: forma juridica (SRL/PFA), TVA si starea abonamentului (billing per-firma).
    p.firms.forEach((f) => {
      const firma = db.getFirma(f.firmaId) || {};
      f.tipEntitate = firma.tipEntitate === 'pfa' ? 'pfa' : 'srl';
      f.tvaPlatitor = !!firma.tvaPlatitor;
      f.sub = plans.firmaStatus(firma);
    });
    // activitate recenta pe firmele accesibile (din jurnalul de audit)
    const recent = (d.audit || []).filter((a) => a.firmaId != null && fids.includes(a.firmaId)).slice(-12).reverse()
      .map((a) => ({ ts: a.ts, username: a.username, action: a.action, detail: a.detail, firma: (db.getFirma(a.firmaId) || {}).nume || '' }));
    res.json(Object.assign(p, { recent }));
  });

  app.get('/api/notifications', (req, res) => {
    const d = db.get();
    const fids = allowedFirme(req.user);
    res.json(decl.notifications(d, fids.map((id) => db.scoped(id))));
  });
};
