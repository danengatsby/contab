'use strict';

// Rutele mijloacelor fixe: registru, plan de amortizare, inregistrarea amortizarii lunii,
// livrabilele PDF (registrul, fisa mijlocului fix) si scadentarul de leasing (JSON + PDF).
// Modul de rute: register(app, ctx).

const assets = require('../assets');
const catalogDurate = require('../catalogDurate'); // HG 2139/2004 — sugestie in formular, NU calcul
const db = require('../db');
const pdf = require('../pdf');
const coa = require('../chartOfAccounts');
const { leasingSchedule } = require('../leasing');
const { round2 } = require('../util');
const { sendList } = require('../paginate');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit, requireAdmin } = ctx;

  // ── CATALOGUL DURATELOR (HG 2139/2004) ────────────────────────────────────
  // Sta GLOBAL, ca planul de conturi: duratele normale sunt aceleasi pentru toate firmele.
  // Deci importul e `requireAdmin`, din exact acelasi motiv ca la /api/accounts/import —
  // stare globala partajata, iar un cont legat de o singura firma nu are voie s-o rescrie
  // pentru toate celelalte.
  //
  // Cautarea ramane deschisa oricui e autentificat: e un nomenclator public (o hotarare de
  // guvern), nu date de firma, si e inutila daca doar adminul o poate citi.
  app.get('/api/catalog-durate', (req, res) => {
    const d = db.get();
    const lista = d.catalogDurate || [];
    const q = String(req.query.q || '').trim();
    // Fara `q` NU se intoarce catalogul intreg: sunt sute de randuri si nimeni nu le citeste pe
    // toate: se intoarce doar marimea lui, ca interfata sa poata spune „catalog neincarcat".
    if (!q) return res.json({ total: lista.length, rezultate: [] });
    res.json({ total: lista.length, rezultate: catalogDurate.cauta(lista, q, Number(req.query.limit) || 25) });
  });

  app.post('/api/catalog-durate/import', requireAdmin, (req, res) => {
    const { randuri, respinse } = catalogDurate.parse((req.body || {}).csv);
    if (!randuri.length) {
      return res.status(400).json({
        error: 'Niciun rand valid in fisier. Format asteptat: cod;denumire;ani (ex. „2.1.16.1.1;Masini de spalat;8-12").',
        respinse: respinse.slice(0, 20),
      });
    }
    const d = db.get();
    d.catalogDurate = d.catalogDurate || [];
    // Upsert pe cod, ca la planul de conturi: un import repetat corecteaza, nu dubleaza.
    for (const r of randuri) {
      const ex = d.catalogDurate.find((x) => catalogDurate.normalizeazaCod(x.cod) === catalogDurate.normalizeazaCod(r.cod));
      if (ex) Object.assign(ex, r); else d.catalogDurate.push(r);
    }
    db.save();
    logAudit('catalog-durate.import', randuri.length + ' pozitii (HG 2139/2004)', { req });
    // Randurile respinse pleaca inapoi la utilizator, cu numarul liniei: un catalog incarcat pe
    // jumatate fara sa spuna care jumatate l-ar face sa caute degeaba un cod care n-a intrat.
    res.json({ ok: true, importate: randuri.length, total: d.catalogDurate.length, respinse: respinse.slice(0, 50) });
  });

  app.get('/api/assets', (req, res) => {
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
    sendList(req, res, assets.register(S(req), asOf), { label: 'assets' });
  });
  // Metodele de amortizare permise pe un cont (art. 28 alin. (5)). Formularul le cere de AICI, nu
  // le deduce singur: regula decide impozitul, deci nu are voie sa existe in doua exemplare care
  // pot drifta — acelasi motiv pentru care previzualizarea articolului vine de la server.
  app.get('/api/assets/metode', (req, res) => {
    const cont = String(req.query.cont || '').trim();
    const marcaje = { computer: req.query.computer === '1' || req.query.computer === 'true' };
    const amortizabil = assets.esteAmortizabil(cont);
    res.json({
      cont,
      amortizabil: amortizabil.ok,
      motiv: amortizabil.ok ? '' : amortizabil.motiv,
      permise: amortizabil.ok ? assets.metodePermise(cont, marcaje) : [],
      contAmortizare: amortizabil.ok ? assets.contAmortizare(cont) : '',
    });
  });
  app.get('/api/assets/:id/schedule', (req, res) => {
    const a = (S(req).assets || []).find((x) => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: 'Mijloc fix inexistent.' });
    res.json({ asset: a, schedule: assets.schedule(a) });
  });
  app.post('/api/assets', (req, res) => {
    const b = req.body || {};
    if (!b.denumire || !b.cont || !b.cost || !b.durataLuni || !b.dataPif) return res.status(400).json({ error: 'Completeaza denumire, cont, cost, durata si data punerii in functiune.' });
    // ── Gardele contului si ale regimului de amortizare ──────────────────────────────────────
    // Contul nu era verificat DELOC aici: mijlocul fix e singura monografie care isi scrie
    // articolele direct (vezi ruta de amortizare), deci garda din `composeEntry` nu-l atinge.
    // Se verifica in ordinea in care contabilul greseste: contul exista? se amortizeaza? metoda
    // aleasa e permisa pe felul asta de activ?
    const cont = String(b.cont).trim();
    if (!coa.getAccount(cont)) return res.status(400).json({ error: 'Cont inexistent în planul de conturi: ' + cont });
    const amortizabil = assets.esteAmortizabil(cont);
    if (!amortizabil.ok) return res.status(400).json({ error: amortizabil.motiv });
    if (!assets.contAmortizareValid(cont)) {
      return res.status(400).json({ error: 'Contul de amortizare ' + assets.contAmortizare(cont) + ' nu există în planul de conturi. Completează planul înainte de a înregistra mijlocul fix.' });
    }
    const metoda = assets.METHODS.includes(b.metoda) ? b.metoda : 'liniara';
    // Marcajul „computer" schimba metodele permise pe 214, deci se citeste INAINTE de verificare.
    const marcaje = { computer: !!b.computer };
    const motivM = assets.motivMetodaNepermisa(cont, metoda, marcaje);
    if (motivM) return res.status(400).json({ error: motivM });
    if (assets.METHODS.includes(b.metodaFiscala) && b.metodaFiscala !== metoda) {
      const motivF = assets.motivMetodaNepermisa(cont, b.metodaFiscala, marcaje);
      if (motivF) return res.status(400).json({ error: 'Metoda fiscală: ' + motivF });
    }
    const d = db.get();
    const a = {
      id: db.nextId('mf'), firmaId: activeId(req),
      denumire: String(b.denumire), cont,
      furnizor: b.furnizor || '', cui: b.cui || '',
      cost: round2(Number(b.cost) || 0), valoareReziduala: round2(Number(b.valoareReziduala) || 0),
      dataAchizitie: b.dataAchizitie || b.dataPif, dataPif: String(b.dataPif),
      durataLuni: Math.max(1, Number(b.durataLuni) || 1),
      metoda, status: 'activ',
      // Art. 28 alin. (5) lit. b): computerele si echipamentele periferice pot fi amortizate
      // accelerat, desi in planul acesta stau pe 214 alaturi de mobilier, care nu poate. Marcaj
      // EXPLICIT, ca `vehiculM1` — sinteticul nu le deosebeste, iar o euristica pe denumire ar
      // schimba impozitul dupa cum a scris cineva „laptop" sau „calculator".
      ...(b.computer ? { computer: true } : {}),
      // Planul FISCAL (art. 28) e optional: absent inseamna „identic cu cel contabil". Se scrie
      // doar cand difera efectiv — un camp egal cu cel contabil ar sugera o alegere care nu s-a
      // facut, si ar ingheta planul fiscal daca metoda contabila se schimba ulterior.
      ...(assets.METHODS.includes(b.metodaFiscala) && b.metodaFiscala !== b.metoda
        ? { metodaFiscala: b.metodaFiscala } : {}),
      ...(Number(b.durataFiscalaLuni) > 0 && Number(b.durataFiscalaLuni) !== Number(b.durataLuni)
        ? { durataFiscalaLuni: Math.max(1, Number(b.durataFiscalaLuni)) } : {}),
      // Art. 28 alin. (12) lit. m): vehicul de persoane cu maxim 9 scaune -> amortizarea FISCALA
      // e plafonata la 1.500 lei/luna. Marcaj EXPLICIT, nu dedus din contul 2133: acolo intra si
      // camioanele, autoutilitarele si utilajele, care nu au plafon. Un marcaj gresit ar schimba
      // impozitul, deci il pune contabilul, nu o euristica.
      ...(b.vehiculM1 ? { vehiculM1: true } : {}),
    };
    d.assets.push(a);
    logAudit('asset.create', a.denumire + ' (' + a.cont + ')', { req });
    db.save();
    res.json({ ok: true, asset: a });
  });
  // ── INVESTITII ULTERIOARE (modernizari) ───────────────────────────────────────────────────
  // Majoreaza valoarea mijlocului fix si se recupereaza pe durata RAMASA, din luna urmatoare
  // finalizarii (art. 28 alin. (3) Cod fiscal). Articolele contabile ale investitiei se
  // inregistreaza separat, cu tipurile existente (`imobilizare_in_curs` + `punere_in_functiune`);
  // aici se leaga investitia de ACTIV, ca planul de amortizare sa se recalculeze.
  app.post('/api/assets/:id/investitii', (req, res) => {
    const d = db.get();
    const a = (d.assets || []).find((x) => x.id === req.params.id && x.firmaId === activeId(req));
    if (!a) return res.status(404).json({ error: 'Mijloc fix inexistent.' }); // izolare multi-firma
    const b = req.body || {};
    const suma = round2(Number(b.suma) || 0);
    const data = String(b.data || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: 'Completează data finalizării investiției.' });
    if (suma <= 0) return res.status(400).json({ error: 'Valoarea investiției trebuie să fie pozitivă.' });
    if (a.status === 'casat') return res.status(400).json({ error: 'Mijlocul fix este casat — nu se mai pot înregistra investiții la el.' });
    // Efectul incepe cu luna URMATOARE finalizarii. Daca luna aceea e deja INCHISA, amortizarea ei
    // a fost postata dupa planul VECHI, iar recalcularea ar face registrul sa contrazica articolele
    // — exact defectul reparat candva la casare, unde marcarea stergea retroactiv luni intregi.
    const efect = assets.lunaUrmatoare(data);
    try { db.assertPeriodOpen(activeId(req), efect, 'Investiția (efectul ei începe în ' + efect + ')'); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    // Pe un activ deja amortizat integral nu mai exista durata ramasa peste care sa se esaloneze:
    // se cere explicit o prelungire. Nu se inventeaza o durata — ar fi o decizie fiscala luata de
    // cod in locul contabilului.
    const supl = Math.max(0, Math.round(Number(b.durataSuplimentaraLuni) || 0));
    const proba = Object.assign({}, a, { investitii: (a.investitii || []).concat([{ id: 'proba', data, suma, durataSuplimentaraLuni: supl }]) });
    const plan = assets.schedule(proba);
    const ultima = plan.length ? plan[plan.length - 1].period : '';
    if (!supl && (!ultima || assets.lunaUrmatoare(data) > ultima)) {
      return res.status(400).json({ error: 'Mijlocul fix e amortizat integral la data investiției (planul se încheie în '
        + (ultima || '—') + '). Completează durata suplimentară (luni) peste care se recuperează investiția.' });
    }
    a.investitii = a.investitii || [];
    a.investitii.push({ id: db.nextId('inv'), data, suma, document: String(b.document || '').slice(0, 120),
      descriere: String(b.descriere || '').slice(0, 300), ...(supl ? { durataSuplimentaraLuni: supl } : {}) });
    logAudit('asset.investitie', a.denumire + ': ' + suma + ' lei (' + data + ')', { req });
    db.save();
    res.json({ ok: true, asset: a, calc: assets.compute(a, req.query.asOf || null) });
  });
  app.delete('/api/assets/:id/investitii/:invId', (req, res) => {
    const d = db.get();
    const a = (d.assets || []).find((x) => x.id === req.params.id && x.firmaId === activeId(req));
    if (!a) return res.status(404).json({ error: 'Mijloc fix inexistent.' });
    const inv = (a.investitii || []).find((x) => x.id === req.params.invId);
    if (!inv) return res.status(404).json({ error: 'Investiție inexistentă.' });
    try { db.assertPeriodOpen(activeId(req), assets.lunaUrmatoare(inv.data), 'Ștergerea investiției'); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    a.investitii = (a.investitii || []).filter((x) => x !== inv);
    logAudit('asset.investitie.sterge', a.denumire + ': ' + inv.suma, { req });
    db.save();
    res.json({ ok: true, asset: a });
  });
  app.post('/api/assets/:id/scrap', (req, res) => {
    const d = db.get();
    const a = (d.assets || []).find((x) => x.id === req.params.id && x.firmaId === activeId(req));
    if (!a) return res.status(404).json({ error: 'Mijloc fix inexistent.' }); // izolare multi-firma
    a.status = 'casat'; a.dataCasare = (req.body || {}).dataCasare || new Date().toISOString().slice(0, 10);
    logAudit('asset.scrap', a.denumire, { req });
    db.save();
    res.json({ ok: true, asset: a });
  });
  app.delete('/api/assets/:id', (req, res) => {
    const d = db.get();
    const a = (d.assets || []).find((x) => x.id === req.params.id && x.firmaId === activeId(req));
    if (!a) return res.status(404).json({ error: 'Mijloc fix inexistent.' }); // izolare multi-firma
    d.assets = (d.assets || []).filter((x) => x !== a);
    logAudit('asset.delete', a.denumire, { req });
    db.save();
    res.json({ ok: true });
  });
  // Inregistreaza amortizarea lunii (6811 = 281x), o linie pe mijloc fix
  app.post('/api/assets/depreciation', (req, res) => {
    const period = req.query.period;
    if (!period) return res.status(400).json({ error: 'Lipseste perioada (YYYY-MM).' });
    const d = db.get();
    try { db.assertPeriodOpen(activeId(req), period, 'Inregistrarea amortizarii'); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const dep = assets.monthlyDepreciation(S(req).assets, period);
    if (!dep.lines.length) return res.json({ ok: true, message: 'Nicio amortizare de inregistrat pentru ' + period + '.', result: dep });
    const exists = d.entries.find((e) => e.firmaId === activeId(req) && e.tip === 'amortizare_lunara' && e.period === period);
    if (exists) return res.status(400).json({ error: 'Amortizarea pentru ' + period + ' este deja inregistrata.' });
    // Articolul se scrie direct in `d.entries`, deci NU trece prin `composeEntry` — singurul loc
    // care verifica apartenenta la plan. Verificarea se face aici, altfel un cont de amortizare
    // absent (activ vechi, plan incomplet) ar ajunge tacut in balanta si in SAF-T, la ANAF.
    const orfane = [...new Set(dep.lines.map((l) => l.contAmortizare).filter((c) => !coa.getAccount(c)))];
    if (orfane.length) {
      return res.status(400).json({ error: 'Conturi de amortizare inexistente în planul de conturi: ' + orfane.join(', ')
        + '. Completează planul (sau corectează contul mijlocului fix) înainte de a înregistra amortizarea.' });
    }
    db.pushEntry({
      id: db.nextId('e'), firmaId: activeId(req), data: period + '-28', period, tip: 'amortizare_lunara', tipNume: 'Amortizare mijloace fixe',
      partener: '', document: 'Nota amortizare ' + period, explicatie: 'Amortizarea lunară a imobilizărilor',
      fileId: null, system: true,
      lines: dep.lines.map((l) => ({ debit: '6811', credit: l.contAmortizare, suma: l.suma, explicatie: 'Amortizare ' + l.denumire })),
    }, { context: 'amortizare lunara' });
    logAudit('amortizare.lunara', period + ' (' + dep.lines.length + ' MF)', { req });
    db.save();
    res.json({ ok: true, result: dep });
  });

  // ── Livrabile PDF + leasing ──
  app.get('/pdf/assets', (req, res) => {
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
    pdf.assetsRegisterPdf(res, S(req).company, assets.register(S(req), asOf), asOf);
  });
  app.get('/api/leasing-schedule', (req, res) => res.json(leasingSchedule(req.query.principal, req.query.months, req.query.rate, req.query.method)));
  app.get('/pdf/leasing-schedule', (req, res) => pdf.leasingSchedulePdf(res, S(req).company, leasingSchedule(req.query.principal, req.query.months, req.query.rate, req.query.method)));
  app.get('/pdf/asset/:id', (req, res) => {
    const a = (S(req).assets || []).find((x) => x.id === req.params.id);
    if (!a) return res.status(404).send('Mijloc fix inexistent');
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
    const asset = Object.assign({}, a, { contNume: coa.accountName(a.cont) });
    pdf.assetFisaPdf(res, S(req).company, { asset, calc: assets.compute(a, asOf), schedule: assets.schedule(a) });
  });
};
