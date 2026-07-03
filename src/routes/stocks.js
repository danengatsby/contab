'use strict';

// Rutele de stocuri: nomenclator produse + gestiuni, miscari (receptie/iesire/transfer),
// postarea notei contabile pe miscare, inventariere si stoc curent / fisa de magazie.
// Modul de rute: register(app, ctx). Export CSV, seriile de documente si PDF-urile de stoc
// (NIR/bon/aviz) raman deocamdata in server.js (clustere separate).

const db = require('../db');
const { round2 } = require('../util');
const stocks = require('../stocks');
const fiscal = require('../fiscal');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;

  app.get('/api/products', (req, res) => res.json(S(req).products));
  app.post('/api/products', (req, res) => {
    const b = req.body || {};
    if (!b.cod || !b.denumire) return res.status(400).json({ error: 'Completeaza codul si denumirea produsului.' });
    const d = db.get();
    const existing = (d.products || []).find((p) => p.firmaId === activeId(req) && p.cod === b.cod);
    if (existing) {
      Object.assign(existing, { denumire: b.denumire, um: b.um || existing.um, grupa: b.grupa || '', cont: b.cont || existing.cont, codNC: b.codNC || '' });
      db.save();
      return res.json({ ok: true, product: existing });
    }
    const p = { id: db.nextId('prod'), firmaId: activeId(req), cod: String(b.cod), denumire: String(b.denumire), um: b.um || 'buc', grupa: b.grupa || '', cont: b.cont || '371', codNC: b.codNC || '' };
    d.products.push(p);
    logAudit('product.create', p.cod + ' ' + p.denumire, { req });
    db.save();
    res.json({ ok: true, product: p });
  });
  // Import produse din CSV: Cod;Denumire;UM;Cont;Grupa;CodNC (header optional)
  app.post('/api/products/import', (req, res) => {
    const rows = parseCsv((req.body || {}).csv || '');
    if (!rows.length) return res.status(400).json({ error: 'CSV gol sau invalid.' });
    let start = 0;
    if (/cod|denumire/i.test((rows[0][0] || '') + (rows[0][1] || ''))) start = 1;
    const d = db.get();
    const fid = activeId(req);
    let importati = 0;
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      const cod = String(r[0] || '').trim();
      if (!cod || !r[1]) continue;
      const existing = (d.products || []).find((p) => p.firmaId === fid && p.cod === cod);
      const rec = existing || { id: db.nextId('prod'), firmaId: fid, cod };
      Object.assign(rec, { denumire: r[1], um: r[2] || 'buc', cont: r[3] || '371', grupa: r[4] || '', codNC: r[5] || '' });
      if (!existing) d.products.push(rec);
      importati += 1;
    }
    logAudit('products.import', importati + ' produse', { req });
    db.save();
    res.json({ ok: true, importati });
  });
  app.delete('/api/products/:id', (req, res) => {
    const d = db.get();
    d.products = (d.products || []).filter((p) => p.id !== req.params.id);
    d.stockMovements = (d.stockMovements || []).filter((m) => m.productId !== req.params.id);
    db.save();
    res.json({ ok: true });
  });
  // gestiuni (depozite)
  app.get('/api/gestiuni', (req, res) => res.json(S(req).gestiuni));
  app.post('/api/gestiuni', (req, res) => {
    const b = req.body || {};
    if (!b.cod || !b.denumire) return res.status(400).json({ error: 'Completeaza codul si denumirea gestiunii.' });
    const d = db.get();
    const existing = (d.gestiuni || []).find((g) => g.firmaId === activeId(req) && g.cod === b.cod);
    if (existing) { Object.assign(existing, { denumire: b.denumire, gestionar: b.gestionar || '', cont: b.cont || existing.cont }); db.save(); return res.json({ ok: true, gestiune: existing }); }
    const g = { id: db.nextId('gest'), firmaId: activeId(req), cod: String(b.cod), denumire: String(b.denumire), gestionar: b.gestionar || '', cont: b.cont || '371' };
    d.gestiuni.push(g);
    logAudit('gestiune.create', g.cod + ' ' + g.denumire, { req });
    db.save();
    res.json({ ok: true, gestiune: g });
  });
  app.delete('/api/gestiuni/:id', (req, res) => {
    const d = db.get();
    if ((d.stockMovements || []).some((m) => m.firmaId === activeId(req) && (m.gestiuneId === req.params.id || m.gestiuneDestId === req.params.id))) {
      return res.status(400).json({ error: 'Gestiunea are miscari de stoc — sterge-le intai.' });
    }
    d.gestiuni = (d.gestiuni || []).filter((g) => g.id !== req.params.id);
    db.save();
    res.json({ ok: true });
  });
  app.get('/api/stock-movements', (req, res) => res.json(stocks.movementsList(S(req), req.query.period || null)));
  app.post('/api/stock-movements', (req, res) => {
    const b = req.body || {};
    if (!b.productId || !b.tip || !b.cantitate || !b.data) return res.status(400).json({ error: 'Completeaza produsul, tipul, cantitatea si data.' });
    if (!['receptie', 'iesire', 'transfer'].includes(b.tip)) return res.status(400).json({ error: 'Tip miscare invalid.' });
    const d = db.get();
    const fid = activeId(req);
    if (!(d.products || []).find((p) => p.id === b.productId && p.firmaId === fid)) return res.status(400).json({ error: 'Produs inexistent.' });
    const gOk = (id) => !id || (d.gestiuni || []).some((g) => g.id === id && g.firmaId === fid);
    if (!gOk(b.gestiuneId) || !gOk(b.gestiuneDestId)) return res.status(400).json({ error: 'Gestiune inexistenta.' });
    if (b.tip === 'transfer' && (!b.gestiuneId || !b.gestiuneDestId || b.gestiuneId === b.gestiuneDestId)) return res.status(400).json({ error: 'Transferul cere gestiune sursa si destinatie diferite.' });
    const m = {
      id: db.nextId('sm'), firmaId: fid, data: String(b.data), tip: b.tip, productId: b.productId,
      gestiuneId: b.gestiuneId || null, gestiuneDestId: b.tip === 'transfer' ? b.gestiuneDestId : null,
      cantitate: round2(Number(b.cantitate) || 0), pretUnitar: round2(Number(b.pretUnitar) || 0),
      document: b.document || '', furnizor: b.tip === 'receptie' ? (b.furnizor || '') : '', operator: (req.user && req.user.username) || '',
    };
    d.stockMovements.push(m);
    logAudit('stock.move', b.tip + ' ' + m.cantitate, { req });
    db.save();
    res.json({ ok: true, movement: m });
  });
  app.delete('/api/stock-movements/:id', (req, res) => {
    const d = db.get();
    const m = (d.stockMovements || []).find((x) => x.id === req.params.id);
    if (m && m.entryId) d.entries = d.entries.filter((e) => e.id !== m.entryId); // sterge si nota contabila legata
    d.stockMovements = (d.stockMovements || []).filter((x) => x.id !== req.params.id);
    db.save();
    res.json({ ok: true });
  });
  // Descarcarea de gestiune: genereaza nota contabila dintr-o miscare (receptie 3xx=401, iesire 60x=3xx la CMP)
  app.post('/api/stock-movements/:id/post', (req, res) => {
    const d = db.get();
    const v = S(req);
    const m = v.stockMovements.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'Miscare inexistenta.' });
    if (m.entryId) return res.status(400).json({ error: 'Nota contabila este deja generata pentru aceasta miscare.' });
    const p = v.products.find((x) => x.id === m.productId);
    if (!p) return res.status(400).json({ error: 'Produs inexistent.' });
    const suma = round2(stocks.movementValue(p, v.stockMovements, m.id));
    if (suma <= 0) return res.status(400).json({ error: 'Valoare zero — nimic de inregistrat.' });
    const contStoc = p.cont || '371';
    let line; let tip; let tipNume;
    if (m.tip === 'receptie') {
      line = { debit: contStoc, credit: '401', suma, explicatie: 'Receptie ' + p.denumire };
      tip = 'stoc_receptie'; tipNume = 'Receptie in gestiune';
    } else {
      line = { debit: stocks.cogsAccount(contStoc), credit: contStoc, suma, explicatie: 'Descarcare gestiune ' + p.denumire };
      tip = 'stoc_descarcare'; tipNume = 'Descarcare de gestiune';
    }
    const entry = {
      id: db.nextId('e'), firmaId: activeId(req), data: m.data, period: String(m.data).slice(0, 7),
      tip, tipNume, partener: '', partenerCui: '', document: m.document || '', analitic: '', explicatie: line.explicatie,
      fileId: null, system: true, movementId: m.id, lines: [line],
    };
    d.entries.push(entry);
    const mm = d.stockMovements.find((x) => x.id === m.id);
    mm.entryId = entry.id;
    logAudit('stoc.descarcare', tipNume + ' ' + suma, { req });
    db.save();
    res.json({ ok: true, entry });
  });
  // inventariere: lista (scriptic) + inregistrarea diferentelor (plus/minus + imputare)
  app.get('/api/inventory', (req, res) => {
    const v = S(req);
    if (!req.query.gestiune) return res.status(400).json({ error: 'Alege o gestiune.' });
    res.json(stocks.inventoryList(v, req.query.gestiune, req.query.asOf || null));
  });
  app.post('/api/inventory', (req, res) => {
    const b = req.body || {};
    if (!b.gestiuneId || !b.data || !Array.isArray(b.lines)) return res.status(400).json({ error: 'Lipsesc gestiunea, data sau liniile.' });
    const d = db.get();
    const v = S(req);
    const g = v.gestiuni.find((x) => x.id === b.gestiuneId);
    if (!g) return res.status(400).json({ error: 'Gestiune inexistenta.' });
    const tvaRate = (fiscal.FISCAL && fiscal.FISCAL.tvaStandard) || 21;
    const doc = 'Inventar ' + g.cod + ' ' + b.data;
    const result = { plusuri: [], minusuri: [], imputari: [] };
    const operator = (req.user && req.user.username) || '';
    const inv = { id: db.nextId('inv'), firmaId: activeId(req), gestiuneId: g.id, gestiuneCod: g.cod, gestiuneDen: g.denumire, gestionar: g.gestionar || '', operator, data: b.data, ts: new Date().toISOString(), status: 'activ', lines: [], entryIds: [], movementIds: [], totalScriptic: 0, totalFaptic: 0, totalPlus: 0, totalMinus: 0, totalImputat: 0 };
    const addEntry = (e) => { d.entries.push(e); inv.entryIds.push(e.id); };
    const addMove = (mv) => { d.stockMovements.push(mv); inv.movementIds.push(mv.id); };
    for (const ln of b.lines) {
      const p = v.products.find((x) => x.id === ln.productId);
      if (!p) continue;
      const led = stocks.productLedger(p, v.stockMovements, b.data, b.gestiuneId); // scriptic = starea de dinainte de inventar
      const scriptic = led.stocQ; const cmp = led.cmp;
      const faptic = round2(Number(ln.faptic) || 0);
      const diff = round2(faptic - scriptic);
      const cont = p.cont || '371';
      const ivLine = { productId: p.id, cod: p.cod, denumire: p.denumire, um: p.um || 'buc', scriptic, faptic, diff, cmp, valoare: round2(Math.abs(diff) * cmp), tip: diff > 0 ? 'plus' : diff < 0 ? 'minus' : 'ok', imputat: false, tvaImputare: 0 };
      inv.totalScriptic = round2(inv.totalScriptic + led.stocV);
      inv.totalFaptic = round2(inv.totalFaptic + round2(faptic * cmp));
      inv.lines.push(ivLine);
      if (diff === 0) continue;
      if (diff > 0) {
        // plus de inventar: intrare in stoc + 3xx = 758
        const val = round2(diff * (cmp || Number(ln.pret) || 0));
        addMove({ id: db.nextId('sm'), firmaId: activeId(req), data: b.data, tip: 'receptie', productId: p.id, gestiuneId: b.gestiuneId, gestiuneDestId: null, cantitate: diff, pretUnitar: cmp || Number(ln.pret) || 0, document: doc, operator });
        if (val > 0) addEntry({ id: db.nextId('e'), firmaId: activeId(req), data: b.data, period: String(b.data).slice(0, 7), tip: 'inventar_plus', tipNume: 'Plus de inventar', partener: '', partenerCui: '', document: doc, analitic: '', explicatie: 'Plus inventar ' + p.denumire, fileId: null, system: true, lines: [{ debit: cont, credit: '758', suma: val, explicatie: 'Plus de inventar ' + p.cod }] });
        ivLine.valoare = val; inv.totalPlus = round2(inv.totalPlus + val);
        result.plusuri.push({ produs: p.cod, cantitate: diff, valoare: val });
      } else {
        const q = round2(-diff);
        const val = round2(q * cmp);
        addMove({ id: db.nextId('sm'), firmaId: activeId(req), data: b.data, tip: 'iesire', productId: p.id, gestiuneId: b.gestiuneId, gestiuneDestId: null, cantitate: q, pretUnitar: 0, document: doc, operator });
        if (val > 0) addEntry({ id: db.nextId('e'), firmaId: activeId(req), data: b.data, period: String(b.data).slice(0, 7), tip: 'inventar_minus', tipNume: 'Minus de inventar (lipsa)', partener: '', partenerCui: '', document: doc, analitic: '', explicatie: 'Lipsa inventar ' + p.denumire, fileId: null, system: true, lines: [{ debit: stocks.cogsAccount(cont), credit: cont, suma: val, explicatie: 'Lipsa la inventar ' + p.cod }] });
        // imputare gestionar: 4282 = 7588 + 4427
        if (ln.imputa && val > 0) {
          const tva = round2((val * tvaRate) / 100);
          addEntry({ id: db.nextId('e'), firmaId: activeId(req), data: b.data, period: String(b.data).slice(0, 7), tip: 'imputare_lipsa', tipNume: 'Imputare lipsa gestionar', partener: g.gestionar || '', partenerCui: '', document: doc, analitic: '', explicatie: 'Imputare ' + p.denumire + ' catre ' + (g.gestionar || 'gestionar'), fileId: null, system: true, lines: [
            { debit: '4282', credit: '7588', suma: val, explicatie: 'Imputare lipsa ' + p.cod },
            { debit: '4282', credit: '4427', suma: tva, explicatie: 'TVA imputare lipsa ' + p.cod },
          ] });
          ivLine.imputat = true; ivLine.tvaImputare = tva; inv.totalImputat = round2(inv.totalImputat + val + tva);
          result.imputari.push({ produs: p.cod, valoare: val, tva });
        }
        ivLine.valoare = val; inv.totalMinus = round2(inv.totalMinus + val);
        result.minusuri.push({ produs: p.cod, cantitate: q, valoare: val });
      }
    }
    d.inventories.push(inv);
    logAudit('inventar', g.cod + ' ' + b.data + ' (+' + result.plusuri.length + '/-' + result.minusuri.length + ')', { req });
    db.save();
    res.json({ ok: true, id: inv.id, result });
  });
  app.get('/api/inventories', (req, res) => res.json(
    (S(req).inventories || []).slice().sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .map((iv) => ({ id: iv.id, gestiuneCod: iv.gestiuneCod, gestiuneDen: iv.gestiuneDen, data: iv.data, ts: iv.ts, operator: iv.operator || '', status: iv.status || 'activ', stornoData: iv.stornoData || null, totalPlus: iv.totalPlus, totalMinus: iv.totalMinus, totalImputat: iv.totalImputat, nrPlus: iv.lines.filter((l) => l.tip === 'plus').length, nrMinus: iv.lines.filter((l) => l.tip === 'minus').length })),
  ));
  // Stornarea unui inventar: reverseaza notele contabile (storno debit<->credit) si sterge miscarile de reglare
  app.post('/api/inventories/:id/storno', (req, res) => {
    const d = db.get();
    const iv = (d.inventories || []).find((x) => x.id === req.params.id && x.firmaId === activeId(req));
    if (!iv) return res.status(404).json({ error: 'Inventar inexistent.' });
    if (iv.status === 'stornat') return res.status(400).json({ error: 'Inventarul este deja stornat.' });
    const stornoOp = (req.user && req.user.username) || '';
    const stornoData = String((req.body || {}).data || new Date().toISOString().slice(0, 10));
    const docStorno = 'Storno inventar ' + iv.gestiuneCod + ' ' + iv.data;
    const stornoEntryIds = [];
    // 1) note de stornare (reversare debit<->credit, aceleasi sume)
    for (const eid of (iv.entryIds || [])) {
      const orig = d.entries.find((e) => e.id === eid);
      if (!orig) continue;
      const se = {
        id: db.nextId('e'), firmaId: iv.firmaId, data: stornoData, period: String(stornoData).slice(0, 7),
        tip: 'storno_inventar', tipNume: 'Storno ' + orig.tipNume, partener: orig.partener || '', partenerCui: '',
        document: docStorno, analitic: '', explicatie: 'Stornare ' + (orig.explicatie || orig.tipNume), fileId: null, system: true,
        lines: orig.lines.map((l) => ({ debit: l.credit, credit: l.debit, suma: l.suma, explicatie: 'Storno ' + (l.explicatie || '') })),
      };
      d.entries.push(se); stornoEntryIds.push(se.id);
    }
    // 2) sterge miscarile de reglare (readuce stocul la starea de dinainte de inventar)
    d.stockMovements = (d.stockMovements || []).filter((m) => !(iv.movementIds || []).includes(m.id));
    iv.status = 'stornat'; iv.stornoData = stornoData; iv.stornoOperator = stornoOp; iv.stornoEntryIds = stornoEntryIds;
    logAudit('inventar.storno', iv.gestiuneCod + ' ' + iv.data, { req });
    db.save();
    res.json({ ok: true, stornoEntries: stornoEntryIds.length });
  });
  app.get('/api/stocks', (req, res) => res.json(stocks.currentStock(S(req), req.query.asOf || null, req.query.gestiune || null)));
  app.get('/api/stocks/:id/ledger', (req, res) => {
    const v = S(req);
    const p = v.products.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Produs inexistent.' });
    res.json(stocks.productLedger(p, v.stockMovements, req.query.asOf || null, req.query.gestiune || null));
  });
};
