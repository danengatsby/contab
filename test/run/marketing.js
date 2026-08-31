'use strict';

// Portile comerciale sunt o suita separata. O captura invechita trebuie sa opreasca publicarea
// materialelor, nu pornirea serviciului contabil sau un restart de urgenta.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { eq, ok, section, RADACINA } = require('./comun');

function marketing() {
  section('Marketing: pagina publica nu contrazice produsul');
  {
    const pag = fs.readFileSync(path.join(RADACINA, 'public', 'prezentare.html'), 'utf8');
    const login = fs.readFileSync(path.join(RADACINA, 'public', 'index.html'), 'utf8');
    const termeni = fs.readFileSync(path.join(RADACINA, 'public', 'termeni.html'), 'utf8');
    const plans = require('../../src/plans');
    const formulaPret = plans.PRET_LUNAR_PER_FIRMA + ' lei/' + plans.UNITATE_PRET;
    eq('formula comerciala canonica este 99 lei/lună/firmă', formulaPret, '99 lei/lună/firmă');
    ok('formula apare pe login, în prezentare și în Termeni',
      [login, pag, termeni].every((src) => src.includes(formulaPret)));
    ok('loginul nu promite firme nelimitate sub un singur abonament',
      !/Oricâte firme|Unlimited companies/i.test(login));
    const i18n = fs.readFileSync(path.join(RADACINA, 'public', 'i18n.js'), 'utf8');
    ok('poziționarea publică rămâne la firme mici și birouri de contabilitate',
      /Pentru firme mici[\s\S]{0,100}birouri de contabilitate/.test(login));
    ok('poziționarea nu promite firme mari înainte de multi-instanță și failover',
      !/firme mari|large companies/i.test(login + '\n' + i18n));
    ok('pagina publică spune explicit că single-host nu oferă HA sau SLA contractual',
      /o singură mașină[\s\S]{0,220}fără failover[\s\S]{0,260}nu sunt un SLA contractual/i.test(pag));
    ok('pagina explică diferența Simplu / Expert, nu una de preț',
      /Start și Pro au același preț și aceleași funcții/.test(pag)
        && !/Planurile (?:plătite )?(?:se diferențiază|diferă|se deosebesc) (?:doar )?prin preț/i.test(pag));

    const nrTipuri = Object.keys(require('../../src/documentTypes').TYPES).length;
    const statTipuri = Number((pag.match(/<b>(\d+)<\/b> tipuri de operatiuni|<b>(\d+)<\/b> tipuri de opera\u021biuni/) || [])
      .slice(1).find(Boolean));
    eq('numarul de tipuri de operatiuni din pagina = cel real', statTipuri, nrTipuri);
    const nrDecl = Object.keys(require('../../src/declarations').TIPURI).length;
    const statDecl = Number((pag.match(/<b>(\d+)<\/b> declara\u021bii/) || [])[1]);
    eq('numarul de declaratii din pagina = cel real', statDecl, nrDecl);

    const numite = [...new Set([...pag.matchAll(/\bD(100|101|112|205|300|301|307|311|390|394|406)\b/g)]
      .map((m) => m[1]))];
    const xmlSrc = fs.readFileSync(path.join(RADACINA, 'src', 'xml.js'), 'utf8')
      + fs.readFileSync(path.join(RADACINA, 'src', 'saft.js'), 'utf8');
    const fara = numite.filter((d) => !new RegExp('d' + d + 'Xml|D406|saftXml', 'i').test(xmlSrc));
    ok('fiecare declaratie numita in pagina are generator' + (fara.length ? ' — LIPSA: D' + fara.join(', D') : ''),
      fara.length === 0);
    ok('pagina chiar numeste declaratii (poarta nu scaneaza in gol)', numite.length >= 6);
    ok('pagina nu fixeaza numarul de verificari al suitei (drifteaza garantat)',
      !/\d[\s\S]{0,24}verific\u0103ri automate/.test(pag));
    ok('pagina prezinta poarta fiscala ca promisiune a produsului',
      /valideaz\u0103|valida/i.test(pag)
        && /versiune[\s\S]{0,200}DUKIntegrator|DUKIntegrator[\s\S]{0,200}versiune/i.test(pag));
  }

  section('Marketing: materialele publicate nu divergo de sursa lor');
  {
    const mat = path.join(RADACINA, 'public', 'materiale');
    const src = path.join(RADACINA, 'marketing');
    const identic = (a, b) => fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
    const distributie = fs.existsSync(path.join(RADACINA, '.distributie-portabila'))
      || fs.existsSync(path.join(RADACINA, '.distributie-windows'));
    if (distributie) {
      console.log('  ○ SARIT: distributie — sursele din marketing/ nu se livreaza.');
      ok('sarirea este justificata: marketing/ chiar lipseste', !fs.existsSync(src));
      return;
    }

    ok('folderul publicat exista', fs.existsSync(mat));
    ok('sursele de marketing exista', fs.existsSync(src));
    ok('descrierea publicata este identica cu sursa',
      identic(path.join(src, 'descriere.txt'), path.join(mat, 'descriere.txt')));
    const dirCap = path.join(src, 'capturi');
    const capturi = fs.existsSync(dirCap) ? fs.readdirSync(dirCap).filter((f) => /\.(?:png|jpe?g)$/i.test(f)) : [];
    ok('exista capturi de verificat', capturi.length >= 3);
    const divergente = capturi.filter((f) => !identic(path.join(dirCap, f), path.join(mat, f)));
    ok('fiecare captura publicata este identica cu originalul'
      + (divergente.length ? ' — DIFERITE: ' + divergente.join(', ') : ''), divergente.length === 0);

    const manifestSrc = path.join(dirCap, 'capturi-manifest.json');
    const manifestPub = path.join(mat, 'capturi-manifest.json');
    ok('capturile au manifest anti-drift publicat in ambele directoare',
      fs.existsSync(manifestSrc) && identic(manifestSrc, manifestPub));
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf8')); } catch (_) { /* raportat */ }
    ok('manifestul capturilor este JSON valid, schema 1', !!manifest && manifest.schema === 1);
    const obligatorii = ['index.html', 'styles.css', 'u.css', 'erp.css', 'design-system.css', 'erp.js', 'i18n.js',
      'dashboard.js', 'docflow.js', 'livrabile.js', 'rapoarte.js', 'sw.js'];
    ok('amprenta acopera shell-ul si ecranele fotografiate',
      !!manifest && obligatorii.every((f) => (manifest.sources || []).includes(f)));
    let amprenta = '';
    if (manifest && Array.isArray(manifest.sources)) {
      const hash = crypto.createHash('sha256');
      let complet = true;
      for (const rel of manifest.sources) {
        const sursa = path.join(RADACINA, 'public', rel);
        if (typeof rel !== 'string' || rel.includes('..') || !fs.existsSync(sursa)) { complet = false; break; }
        hash.update(rel); hash.update('\0'); hash.update(fs.readFileSync(sursa)); hash.update('\0');
      }
      if (complet) amprenta = hash.digest('hex');
    }
    ok('capturile provin din sursele UI curente', !!manifest && amprenta === manifest.sourceFingerprint);
    const sw = fs.readFileSync(path.join(RADACINA, 'public', 'sw.js'), 'utf8');
    const cacheCurent = (sw.match(/const CACHE = ['"]([^'"]+)/) || [])[1] || '';
    ok('manifestul poarta aceeasi versiune PWA ca aplicatia', !!manifest && manifest.uiCache === cacheCurent);
    ok('manifestul enumera exact toate imaginile publicate', !!manifest
      && JSON.stringify([...(manifest.captures || [])].sort()) === JSON.stringify([...capturi].sort()));
    const pngCorecte = capturi.filter((f) => f.endsWith('.png')).every((f) => {
      const b = fs.readFileSync(path.join(dirCap, f));
      return b.length > 24 && b.readUInt32BE(16) === 2880 && b.readUInt32BE(20) === 1800;
    });
    ok('PNG-urile pastreaza viewportul 1440×900 la 2×', pngCorecte);
    ok('fixture-ul publicat ramane realist', !!manifest && manifest.portfolio
      && manifest.portfolio.firms === 7 && manifest.portfolio.conformity >= 70
      && manifest.portfolio.conformity <= 90 && manifest.portfolio.overdue === 0);
    const robots = path.join(RADACINA, 'public', 'robots.txt');
    ok('robots.txt exista', fs.existsSync(robots));
    ok('robots.txt exclude materialele din indexare',
      fs.existsSync(robots) && /Disallow:\s*\/materiale\//.test(fs.readFileSync(robots, 'utf8')));
  }
}

module.exports = marketing;
