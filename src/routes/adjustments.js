'use strict';

// Evaluari si ajustari de sfarsit de perioada: buget vs realizat, reevaluarea valutara a
// soldurilor in valuta (diferente de curs), ajustarea pentru deprecierea creantelor vechi
// (provizion 6814=491 / reluare 491=7814) si scoaterea din evidenta a creantelor neincasabile
// (654=4111 + reluarea ajustarii). Modul de rute: register(app, ctx).

const db = require('../db');
const coa = require('../chartOfAccounts');
const acc = require('../accounting');
const rep = require('../reporting');
const fxreval = require('../fxreval');
const fiscal = require('../fiscal');
const { aging } = require('../analytic');

/** Partea DEDUCTIBILA din ajustarea creantelor eligibile (art. 26 alin. (1) lit. c), la rulare. */
function pctArt26() { return Number(fiscal.FISCAL.ajustariCreantePct) || 0; }
const { round2, period: periodOf } = require('../util');
const { sendList } = require('../paginate');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;

  // ── Buget vs realizat ──
  app.get('/api/budgets', (req, res) => {
    const fid = activeId(req); const year = req.query.year;
    sendList(req, res, (db.get().budgets || []).filter((t) => t.firmaId === fid && (!year || String(t.an) === String(year))), { label: 'budgets' });
  });
  app.post('/api/budgets', (req, res) => {
    const b = req.body || {}; const cont = String(b.cont || '').trim();
    if (!coa.getAccount(cont)) return res.status(400).json({ error: 'Cont inexistent in plan: ' + cont });
    const an = String(b.an || new Date().getFullYear());
    const d = db.get(); const fid = activeId(req);
    const t = (d.budgets || []).find((x) => x.firmaId === fid && String(x.an) === an && x.cont === cont);
    const rec = t || { id: db.nextId('bud'), firmaId: fid, an, cont };
    rec.an = an; rec.cont = cont; rec.suma = round2(Number(b.suma) || 0);
    if (!t) d.budgets.push(rec);
    logAudit('buget.save', an + ' ' + cont + ': ' + rec.suma, { req });
    db.save();
    res.json({ ok: true, budget: rec });
  });
  app.delete('/api/budgets/:id', (req, res) => {
    const d = db.get(); const fid = activeId(req);
    d.budgets = (d.budgets || []).filter((t) => !(t.id === req.params.id && t.firmaId === fid));
    logAudit('buget.delete', req.params.id, { req });
    db.save();
    res.json({ ok: true });
  });
  app.get('/api/budget-report', (req, res) => {
    const fid = activeId(req); const year = req.query.year || String(new Date().getFullYear());
    const budgets = (db.get().budgets || []).filter((t) => t.firmaId === fid && String(t.an) === String(year));
    res.json(rep.budgetReport(S(req), budgets, year));
  });

  // ── Reevaluare valutara la sfarsit de perioada ──
  app.get('/api/fx-reval/candidates', (req, res) => sendList(req, res, fxreval.candidates(S(req), req.query.asOf || null), { label: 'fx-reval/candidates' }));
  app.post('/api/fx-reval/preview', (req, res) => {
    const b = req.body || {};
    res.json(fxreval.buildRevaluation(S(req), b.asOf || null, Array.isArray(b.items) ? b.items : []));
  });
  app.post('/api/fx-reval/post', (req, res) => {
    const b = req.body || {}; const fid = activeId(req);
    const asOf = b.asOf || new Date().toISOString().slice(0, 10);
    const r = fxreval.buildRevaluation(S(req), asOf, Array.isArray(b.items) ? b.items : []);
    if (!r.lines.length) return res.status(400).json({ error: 'Nicio diferenta de reevaluare de inregistrat.' });
    for (const ln of r.lines) if (!coa.getAccount(ln.debit) || !coa.getAccount(ln.credit)) return res.status(400).json({ error: 'Cont inexistent: ' + ln.debit + '/' + ln.credit });
    const data = String(asOf).length === 7 ? asOf + '-28' : asOf;
    const firma = db.getFirma(fid) || {};
    if (firma.lockedUntil && periodOf(data) <= firma.lockedUntil) return res.status(400).json({ error: 'Perioada ' + periodOf(data) + ' este inchisa.' });
    const entry = {
      id: db.nextId('e'), firmaId: fid, data, period: periodOf(data),
      tip: 'reevaluare_valutara', tipNume: 'Reevaluare valutara la sfarsit de perioada',
      partener: '', document: 'Reevaluare ' + periodOf(data), explicatie: 'Diferențe de curs din reevaluarea soldurilor în valută',
      fileId: null, system: false, lines: r.lines,
    };
    db.pushEntry(entry, { context: 'reevaluare valutara' });
    logAudit('reevaluare.valutara', periodOf(data) + ': fav ' + r.totalFavorabil + ' / nefav ' + r.totalNefavorabil, { req });
    db.save();
    res.json({ ok: true, entry, totalFavorabil: r.totalFavorabil, totalNefavorabil: r.totalNefavorabil });
  });

  // ── INVENTARIEREA: valorile de inventar si registrul-inventar ─────────────────────────────
  // Stau AICI, nu in `reports.js`, fiindca sunt o EVALUARE de sfarsit de perioada, ca reevaluarea
  // valutara si ajustarea creantelor de mai jos — nu un raport. (Si fiindca `reports.js` primeste
  // un ctx fara `logAudit`: e un modul de citire, iar o scriere acolo cadea in 500.)
  // Se introduce doar valoarea de inventar; valoarea contabila, diferenta si propunerea de
  // ajustare se DERIVA — o diferenta salvata ar ramane adevarata dupa ce soldul se schimba.
  app.get('/api/registru-inventar', (req, res) => {
    const an = req.query.an || String(new Date().getFullYear());
    res.json(rep.registruInventar(S(req), req.query.period || (an + '-12'), an));
  });
  app.get('/api/inventar-valori', (req, res) => {
    const an = String(req.query.an || new Date().getFullYear());
    sendList(req, res, (S(req).inventarAnual || []).filter((x) => String(x.an) === an), { label: 'inventar-valori' });
  });
  app.post('/api/inventar-valori', (req, res) => {
    const b = req.body || {};
    const cont = String(b.cont || '').trim();
    if (!coa.getAccount(cont)) return res.status(400).json({ error: 'Cont inexistent în planul de conturi: ' + cont });
    const an = String(b.an || new Date().getFullYear());
    // Valoarea GOALA sterge randul: „neinventariat" trebuie sa fie exprimabil, altfel un zero
    // tastat din greseala ar ramane pe veci si ar propune scoaterea intregului sold.
    const gol = b.valoareInventar == null || b.valoareInventar === '';
    const d = db.get(); const fid = activeId(req);
    d.inventarAnual = d.inventarAnual || [];
    const ex = d.inventarAnual.find((x) => x.firmaId === fid && String(x.an) === an && String(x.cont) === cont);
    if (gol) {
      d.inventarAnual = d.inventarAnual.filter((x) => x !== ex);
      logAudit('inventar.valoare.sterge', an + ' ' + cont, { req });
      db.save();
      return res.json({ ok: true, sters: !!ex });
    }
    const rec = ex || { id: db.nextId('inv'), firmaId: fid, an, cont };
    rec.valoareInventar = round2(Number(b.valoareInventar) || 0);
    rec.cauza = String(b.cauza || '').slice(0, 300);
    if (!ex) d.inventarAnual.push(rec);
    logAudit('inventar.valoare', an + ' ' + cont + ': ' + rec.valoareInventar, { req });
    db.save();
    res.json({ ok: true, valoare: rec });
  });

  // ── Ajustarea deprecierii creantelor + scoaterea din evidenta ──
  //
  // DOUA BAZE, deliberat diferite — asta e miezul:
  //   contabila — creantele mai vechi de 90 de zile. E o judecata de DEPRECIERE (OMFP 1802/2014):
  //               incasarea e indoielnica, deci valoarea se diminueaza. Nicio lege nu fixeaza
  //               pragul, iar 90 de zile e o practica rezonabila. Ramane neschimbata.
  //   fiscala   — doar partea care indeplineste CUMULATIV conditiile art. 26 alin. (1) lit. c):
  //               peste 270 de zile de la scadenta, negarantata de alta persoana, datorata de o
  //               persoana neafiliata. Din ea se deduce 30%.
  //
  // Pana acum exista o singura baza — cea de 90 de zile — iar `deductibilitate.js` acorda 30%
  // deducere pe TOT contul 6814. Adica se deducea pentru creante de 91 de zile, care nu au acest
  // drept: impozit subdeclarat, vizibil abia la control, cu accesorii.
  //
  // DE CE E NEVOIE DE CONFIRMARE EXPLICITA, nu doar de calcul: aplicatia nu tine scadenta
  // creantelor (vezi si `bilant.js`, unde creantele fara evidenta de scadenta merg integral la
  // „pana la un an"), deci vechimea se masoara de la DATA DOCUMENTULUI. Cum scadenta e mereu
  // ulterioara facturii, vechimea calculata asa e mai MARE decat cea legala: o creanta de 280 de
  // zile de la factura poate avea 250 de la scadenta si sa nu se califice. Candidatii propusi de
  // aplicatie sunt deci un plafon SUPERIOR, nu un raspuns. Fara confirmare, baza fiscala ramane
  // ZERO si ajustarea e integral nedeductibila — „nu stiu" nu are voie sa cada in „se deduce",
  // aceeasi regula ca la IPC-ul din art. 41.
  function computeProvizion(v, asOf, pct) {
    const ag = aging(v, asOf);
    const p = pct == null ? 100 : pct;
    const parteneri = (v.partners || {});
    const detalii = ag.clienti.filter((c) => c.b90plus > 0).map((c) => {
      const cheie = String(c.cui || '').replace(/^ro/i, '').replace(/\s/g, '');
      const pr = parteneri[cheie] || {};
      // Motivele de excludere se DUC PE RAND, nu se scad tacit: contabilul trebuie sa vada de ce
      // o creanta veche de un an nu aduce nicio deducere.
      const excluderi = [];
      if (pr.afiliat) excluderi.push('persoană afiliată');
      if (pr.creanteGarantate) excluderi.push('creanță garantată');
      const eligibil = !excluderi.length ? round2(c.b270plus) : 0;
      return {
        partener: c.partener, cui: c.cui, vechi: c.b90plus, provizion: round2((c.b90plus * p) / 100),
        peste270: round2(c.b270plus), eligibilArt26: eligibil, excluderi,
      };
    });
    const base = round2(detalii.reduce((s, c) => s + c.vechi, 0));
    const necesar = round2((base * p) / 100);
    const m = acc.accumulate(acc.allLines(acc.postedEntries(v)));
    const c491 = m['491'] || { d: 0, c: 0 };
    const existent = round2(c491.c - c491.d);
    // Baza fiscala CANDIDAT: ajustarea aferenta creantelor eligibile, la acelasi procent.
    const bazaEligibila = round2(detalii.reduce((s, c) => s + c.eligibilArt26, 0));
    const art26Candidat = round2((bazaEligibila * p) / 100);
    return {
      asOf: ag.asOf, pct: p, base, necesar, existent, deAjustat: round2(necesar - existent), detalii,
      art26: {
        creanteEligibile: bazaEligibila,
        ajustareEligibila: art26Candidat,
        deducereMaxima: round2((art26Candidat * pctArt26()) / 100),
        pctDeductibil: pctArt26(),
        vechimeDinDataDocumentului: true,
        nota: 'Vechimea e măsurată de la data documentului, nu de la scadență (aplicația nu ține scadența creanțelor), '
          + 'deci suma e un plafon superior. Deducerea de ' + pctArt26() + '% se acordă doar dacă cele trei condiții '
          + 'din art. 26 alin. (1) lit. c) sunt îndeplinite cumulativ — confirmă-le explicit la înregistrare.',
      },
    };
  }
  app.get('/api/provizion', (req, res) => res.json(computeProvizion(S(req), req.query.asOf || null, req.query.pct ? Number(req.query.pct) : 100)));
  // Scoaterea din evidenta a unei creante neincasabile: 654 = 4111 (pierdere) + reluare 491 = 7814
  app.post('/api/writeoff', (req, res) => {
    const v = S(req);
    const b = req.body || {};
    const suma = round2(Number(b.suma) || 0);
    if (!b.partener || suma <= 0) return res.status(400).json({ error: 'Completeaza partenerul si suma.' });
    const data = b.data && String(b.data).length === 10 ? b.data : new Date().toISOString().slice(0, 10);
    const period = String(data).slice(0, 7);
    const lines = [{ debit: '654', credit: '4111', suma, explicatie: 'Creanță neîncasabilă ' + b.partener }];
    const m = acc.accumulate(acc.allLines(acc.postedEntries(v)));
    const c491 = m['491'] || { d: 0, c: 0 };
    const existing491 = round2(c491.c - c491.d);
    const revers = round2(Math.min(suma, existing491));
    if (revers > 0) lines.push({ debit: '491', credit: '7814', suma: revers, explicatie: 'Reluare ajustare ' + b.partener });
    db.pushEntry({
      id: db.nextId('e'), firmaId: activeId(req), data, period, tip: 'scoatere_creanta', tipNume: 'Scoatere din evidenta creanta neincasabila',
      partener: b.partener, partenerCui: b.cui || '', document: 'Nota scoatere ' + period, analitic: '', explicatie: 'Creanță neîncasabilă ' + b.partener, fileId: null, system: true, lines,
    }, { context: 'scoatere creanta din evidenta' });
    logAudit('writeoff', b.partener + ' ' + suma, { req });
    db.save();
    res.json({ ok: true, suma, reversProvizion: revers });
  });
  app.post('/api/provizion', (req, res) => {
    const b = req.body || {};
    const pct = b.pct != null ? Number(b.pct) : 100;
    const p = computeProvizion(S(req), b.asOf || null, pct);
    if (Math.abs(p.deAjustat) < 0.005) return res.json({ ok: true, message: 'Ajustarea este deja la nivelul necesar (' + p.necesar + ').', result: p });
    const data = b.asOf && String(b.asOf).length === 10 ? b.asOf : (p.asOf || new Date().toISOString().slice(0, 10));
    const period = String(data).slice(0, 7);
    const up = p.deAjustat > 0;
    const line = up
      ? { debit: '6814', credit: '491', suma: p.deAjustat, explicatie: 'Ajustare depreciere creanțe' }
      : { debit: '491', credit: '7814', suma: -p.deAjustat, explicatie: 'Reluare ajustare creanțe' };
    // MARCAJUL FISCAL, pe articol — ca `auto50` si `lipsaNeimputabila`: incadrarea nu se poate
    // deduce din conturi la finalul anului, fiindca acelasi cont 6814 poarta si ajustari care se
    // califica, si ajustari care nu. Se scrie DOAR cat s-a confirmat explicit si doar pana la
    // candidatul calculat: o confirmare nu poate ridica baza peste creantele care chiar au
    // vechimea ceruta. Fara confirmare ramane 0, deci ajustarea e integral nedeductibila.
    const confirmat = !!b.confirmArt26;
    const bazaArt26 = (up && confirmat)
      ? round2(Math.min(p.deAjustat, (p.art26 || {}).ajustareEligibila || 0))
      : 0;
    db.pushEntry({
      id: db.nextId('e'), firmaId: activeId(req), data, period,
      tip: up ? 'provizion_creante' : 'reluare_provizion', tipNume: up ? 'Ajustare depreciere creante (6814=491)' : 'Reluare ajustare creante (491=7814)',
      partener: '', partenerCui: '', document: 'Nota ajustare ' + period, analitic: '', explicatie: line.explicatie, fileId: null, system: true, lines: [line],
      ...(bazaArt26 > 0 ? { bazaArt26 } : {}),
    }, { context: 'ajustare depreciere creante' });
    logAudit('provizion', period + ' ' + p.deAjustat + (up ? ' (baza art. 26: ' + bazaArt26 + ')' : ''), { req });
    db.save();
    res.json({ ok: true, result: p });
  });
};
