'use strict';

// Fisierul de plati catre banca (pain.001). Strat SUBTIRE: compune lotul din datele existente
// (facturi furnizor deschise din scadentar, respectiv restul de plata din statul de salarii) si
// il trece prin generatorul pur din src/sepa.js.
//
// NU posteaza nimic in contabilitate — plata se inregistreaza la aparitia in extras, prin
// reconciliere. Vezi antetul din src/sepa.js pentru motiv.

const db = require('../db');
const sepa = require('../sepa');
const analytic = require('../analytic');
const { statPlataPerioada } = require('../payroll');
const { round2 } = require('../util');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;

  /** Lotul propus pentru furnizori: soldurile deschise din scadentar + IBAN-ul din nomenclator. */
  function propuneriFurnizori(v, fid, asOf) {
    const ag = analytic.aging(v, asOf);
    const parteneri = db.get().partners[fid] || {};
    return (ag.furnizori || []).map((f) => {
      const p = parteneri[String(f.cui || '').replace(/^ro/i, '')] || {};
      return {
        tip: 'furnizor', beneficiar: f.partener, cui: f.cui || '',
        iban: p.iban || '', bic: p.bic || '', suma: round2(f.total),
        detalii: 'Plata furnizor ' + (f.partener || ''),
        ref: 'F' + String(f.cui || '').slice(0, 10),
        // Steag explicit: interfata trebuie sa arate DE CE un rand nu poate intra in lot,
        // nu doar sa-l ascunda.
        gata: !!p.iban && sepa.validIban(p.iban),
        motiv: !p.iban ? 'fara IBAN in nomenclatorul de parteneri' : (!sepa.validIban(p.iban) ? 'IBAN invalid' : ''),
      };
    });
  }

  /** Lotul propus pentru salarii: restul de plata din statul lunii. */
  function propuneriSalarii(v, period) {
    const sp = statPlataPerioada(v, period);
    const byId = new Map((v.angajati || []).map((a) => [a.id, a]));
    return (sp.rows || []).filter((r) => Number(r.net) > 0).map((r) => {
      const a = byId.get(r.angajatId) || {};
      return {
        tip: 'salariu', beneficiar: r.nume || a.nume || '', cui: '',
        iban: r.iban || a.iban || '', bic: '', suma: round2(r.net),
        detalii: 'Salariu net ' + period,
        ref: 'S' + String(r.angajatId || '').replace(/[^A-Za-z0-9]/g, ''),
        gata: !!(r.iban || a.iban) && sepa.validIban(r.iban || a.iban),
        motiv: !(r.iban || a.iban) ? 'angajatul nu are IBAN completat'
          : (!sepa.validIban(r.iban || a.iban) ? 'IBAN invalid' : ''),
      };
    });
  }

  // Propunerile (citire): ce s-ar putea plati si ce lipseste ca sa se poata.
  app.get('/api/plati/propuneri', (req, res) => {
    const v = S(req);
    const fid = activeId(req);
    const tip = req.query.tip === 'salarii' ? 'salarii' : 'furnizori';
    const randuri = tip === 'salarii'
      ? propuneriSalarii(v, req.query.period || new Date().toISOString().slice(0, 7))
      : propuneriFurnizori(v, fid, req.query.asOf);
    const firma = db.getFirma(fid) || {};
    res.json({
      tip,
      // Platitorul: fara IBAN pe firma nu se poate genera nimic, deci se semnaleaza separat.
      platitor: { nume: firma.nume || '', iban: firma.iban || '', bic: firma.bic || '' },
      platitorGata: !!firma.iban && sepa.validIban(firma.iban),
      randuri,
      gata: randuri.filter((r) => r.gata).length,
      total: round2(randuri.filter((r) => r.gata).reduce((s, r) => s + r.suma, 0)),
    });
  });

  // Generarea fisierului. POST (corpul poarta selectia si sumele ajustate), dar sub /xml/ ca
  // orice alt fisier descarcabil — prefixele de download sunt o lista inchisa, deliberat.
  app.post('/xml/pain001', (req, res) => {
    const b = req.body || {};
    const fid = activeId(req);
    const firma = db.getFirma(fid) || {};
    const plati = (Array.isArray(b.plati) ? b.plati : []).map((x) => ({
      beneficiar: x.beneficiar, iban: x.iban, bic: x.bic, suma: Number(x.suma), detalii: x.detalii, ref: x.ref,
    }));
    let xmlStr;
    try {
      xmlStr = sepa.buildPain001({
        msgId: b.msgId || String(Date.now()),
        execDate: b.execDate, moneda: b.moneda || 'RON',
        debitor: { nume: firma.nume, iban: firma.iban, bic: firma.bic },
        plati,
      });
    } catch (e) {
      // Toate problemele deodata (nu prima): un lot de 40 de randuri corectat rand cu rand,
      // cu cate o generare esuata intre ele, e o pierdere de timp evitabila.
      return res.status(e.status || 400).json({ error: e.message, probleme: e.probleme || [] });
    }
    const total = round2(plati.reduce((s, x) => s + (Number(x.suma) || 0), 0));
    logAudit('plati.pain001', plati.length + ' plati, total ' + total + ' ' + (b.moneda || 'RON'), { req });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="plati-' + new Date().toISOString().slice(0, 10) + '.xml"');
    res.send(xmlStr);
  });
};
