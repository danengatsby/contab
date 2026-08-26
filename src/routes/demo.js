'use strict';

// Utilitare de administrare a datelor demonstrative (admin): resetarea contului demo public din
// snapshot (data/demo-firma.json), regenerarea snapshot-ului din starea curenta si incarcarea
// exemplului din ghid. Modul de rute: register(app, ctx) -> { resetDemo } (helperul e folosit si
// de jobul zilnic de reset din server.js).

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { seed } = require('../seed');

const DEMO_SNAPSHOT = path.join(db.DATA_DIR, 'demo-firma.json');

function monthIndex(period) {
  const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : NaN;
}
function periodAt(index) { return String(Math.floor(index / 12)).padStart(4, '0') + '-' + String((index % 12) + 1).padStart(2, '0'); }
function shiftIso(value, delta, today) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (!m) return value;
  const idx = Number(m[1]) * 12 + Number(m[2]) - 1 + delta;
  const year = Math.floor(idx / 12); const month = idx % 12;
  const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  let day = Math.min(Number(m[3]), maxDay);
  const targetPeriod = periodAt(idx);
  if (targetPeriod === today.slice(0, 7)) day = Math.min(day, Number(today.slice(8, 10)));
  return targetPeriod + '-' + String(day).padStart(2, '0') + m[4];
}

/** Face snapshot-ul demonstrativ evergreen: două luni relevante, sold bancar plauzibil și
 * obligații istorice marcate ca depuse. Vizitatorul vede un exemplu de lucru, nu restanțe create
 * doar fiindcă snapshot-ul a îmbătrânit. Funcția mută numai copia citită pentru import. */
function prepareDemoBundle(bundle, now) {
  const today = new Date(now || Date.now()).toISOString().slice(0, 10);
  const periods = [...new Set((bundle.entries || []).map((e) => String(e.period || e.data || '').slice(0, 7)).filter((p) => /^\d{4}-\d{2}$/.test(p)))].sort();
  if (!periods.length) return bundle;
  const keep = periods.slice(-2); const latest = keep[keep.length - 1];
  const delta = monthIndex(today.slice(0, 7)) - monthIndex(latest);
  const mapPeriod = (p) => periodAt(monthIndex(p) + delta);
  const selected = new Set(keep);

  bundle.entries = (bundle.entries || []).filter((e) => selected.has(String(e.period || e.data || '').slice(0, 7))).map((e) => {
    const src = String(e.period || e.data).slice(0, 7);
    e.period = mapPeriod(src); e.data = shiftIso(e.data, delta, today);
    // În exemplu facturile emise au parcurs deja SPV; altfel fiecare snapshot devine automat
    // restant după cinci zile și panoul demo începe cu alerte roșii.
    if (/^factura_vanzare/.test(e.tip || '')) e.spv = { index: 'DEMO', stare: 'trimisa' };
    return e;
  });
  bundle.stockMovements = (bundle.stockMovements || []).filter((x) => selected.has(String(x.data || '').slice(0, 7)))
    .map((x) => { x.data = shiftIso(x.data, delta, today); return x; });
  bundle.payrollHistory = (bundle.payrollHistory || []).filter((x) => selected.has(String(x.period || '').slice(0, 7)))
    .map((x) => { x.period = mapPeriod(x.period); return x; });
  bundle.declarations = (bundle.declarations || []).filter((x) => selected.has(String(x.period || '').slice(0, 7)))
    .map((x) => Object.assign(x, { period: mapPeriod(x.period), status: 'depusa', submittedAt: shiftIso(x.submittedAt || today, delta, today) }));

  // Încasările lunare ale exemplului intrau toate în casă, în timp ce plățile ieșeau toate din
  // bancă. Pe un istoric mai lung asta producea banca negativă și numerar exagerat. Exemplul
  // folosește încasare prin bancă, scenariul obișnuit pentru facturile B2B prezentate.
  for (const e of bundle.entries) if (e.tip === 'incasare_client') {
    for (const l of (e.lines || [])) if (String(l.debit) === '5311') l.debit = '5121';
  }

  const previous = periodAt(monthIndex(today.slice(0, 7)) - 1);
  const fid = (bundle.firma || {}).id;
  for (const tip of ['d300', 'd394', 'd112', 'saft', 'd100']) {
    if (bundle.declarations.some((x) => x.period === previous && x.tip === tip)) continue;
    bundle.declarations.push({ id: 'demo-' + tip + '-' + previous, firmaId: fid, tip, period: previous,
      status: 'depusa', generatedAt: today + 'T08:00:00.000Z', submittedAt: today + 'T09:00:00.000Z', recipisa: 'DEMO', note: 'Exemplu demonstrativ' });
  }
  if (bundle.firma) bundle.firma.createdAt = mapPeriod(keep[0]) + '-01T00:00:00.000Z';
  for (const a of (bundle.assets || [])) {
    a.dataAchizitie = shiftIso(a.dataAchizitie, delta, today);
    a.dataPif = shiftIso(a.dataPif, delta, today);
  }
  return bundle;
}

/** Provisioning idempotent al perechii demo: patronul `demo` (deja creat pe productie) + contabilul
 *  `demo-contabil`. Ambele partajeaza firma demo (colaborare patron<->contabil, ambele opereaza).
 *  Ruleaza la boot si la fiecare reset — restaureaza legatura daca un vizitator a scos un cont in demo.
 *  Nu creeaza nimic daca nu exista `demo` (dev/test fara cont demo). */
function ensureDemoContabil() {
  const d = db.get();
  const demo = d.users.find((u) => u.username === 'demo');
  const fid = demo && (demo.firme || [])[0];
  if (!demo || !fid) return null;
  let contabil = d.users.find((u) => u.username === 'demo-contabil');
  if (!contabil) {
    contabil = { id: db.nextUserId(), username: 'demo-contabil', salt: '', hash: '', role: 'user', firme: [], firmaActiva: fid, subscription: { status: 'active', plan: 'pro' } };
    d.users.push(contabil);
  }
  // ambele conturi trebuie sa aiba acces la firma demo (opereaza amandoua)
  demo.firme = demo.firme || []; if (!demo.firme.includes(fid)) demo.firme.push(fid);
  contabil.firme = contabil.firme || []; if (!contabil.firme.includes(fid)) contabil.firme.push(fid);
  // Demo-ul este singura excepție intenționat operabilă fără configurare manuală; dreptul este
  // materializat, nu dedus din simpla apartenență la firmă.
  demo.firmaRoluri = Object.assign({}, demo.firmaRoluri || {}, { [fid]: 'aprobator' });
  contabil.firmaRoluri = Object.assign({}, contabil.firmaRoluri || {}, { [fid]: 'aprobator' });
  if (!contabil.firmaActiva || !contabil.firme.includes(contabil.firmaActiva)) contabil.firmaActiva = fid;
  contabil.subscription = { status: 'active', plan: 'pro' }; // tip „contabil" (Pro)
  return contabil;
}

// Reseteaza firma demo din snapshot + igiena pe utilizatorii demo (contor AI, date personale, mesaje).
function resetDemo() {
  const d = db.get();
  const demo = d.users.find((u) => u.username === 'demo');
  const fid = demo && (demo.firme || [])[0];
  if (!fid || !fs.existsSync(DEMO_SNAPSHOT)) return { ok: false, reason: 'fara demo sau snapshot' };
  const bundle = prepareDemoBundle(JSON.parse(fs.readFileSync(DEMO_SNAPSHOT, 'utf8')));
  const keepActive = d.firmaActiva; // importFirma muta firma activa — o pastram
  db.importFirma(bundle, { targetFid: fid, deferSave: true });
  d.firmaActiva = keepActive;
  ensureDemoContabil(); // reface perechea demo<->demo-contabil (ambele pe firma demo)
  // igiena pe conturile demo: contorul AI, datele personale, conversatiile de suport
  for (const u of d.users.filter((x) => x.username === 'demo' || x.username === 'demo-contabil')) {
    delete u.aiUsage; delete u.profil; u.email = '';
    d.messages = (d.messages || []).filter((m) => m.userId !== u.id);
  }
  db.save();
  return { ok: true, firmaId: fid };
}

function register(app, ctx) {
  const { requireAdmin, logAudit } = ctx;

  app.post('/api/demo/reset', requireAdmin, (req, res) => {
    const r = resetDemo();
    logAudit('demo.reset', r.ok ? 'resetat manual' : r.reason, { req, firmaId: null });
    res.json(r);
  });
  // Regenereaza snapshot-ul din starea CURENTA a firmei demo (dupa o curatare manuala).
  app.post('/api/demo/snapshot', requireAdmin, (req, res) => {
    const demo = db.get().users.find((u) => u.username === 'demo');
    const fid = demo && (demo.firme || [])[0];
    if (!fid) return res.status(400).json({ error: 'Nu exista firma demo.' });
    fs.writeFileSync(DEMO_SNAPSHOT, JSON.stringify(db.exportFirma(fid)));
    logAudit('demo.snapshot', 'snapshot demo regenerat', { req, firmaId: null });
    res.json({ ok: true });
  });

  app.post('/api/seed', requireAdmin, (req, res) => {
    const r = seed();
    res.json({ ok: true, message: 'Exemplu incarcat: ' + r.entries + ' inregistrari pentru ' + r.period + '.' });
  });

  return { resetDemo, ensureDemoContabil };
}
register.prepareDemoBundle = prepareDemoBundle;
module.exports = register;
