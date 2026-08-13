'use strict';

// Validare pre-depunere a declaratiilor XML: bine-format + campuri obligatorii + CUI/perioada valide.
// NU inlocuieste validarea oficiala fata de XSD-urile ANAF (foloseste DUKIntegrator pentru asta);
// prinde insa erorile frecvente inainte de incarcare.

function wellFormed(xml) {
  const s = String(xml || '');
  if (!s.trim().startsWith('<?xml')) return false;
  const lt = (s.match(/</g) || []).length;
  const gt = (s.match(/>/g) || []).length;
  return lt > 0 && lt === gt;
}

function attr(xml, name) {
  const m = String(xml).match(new RegExp('\\b' + name + '="([^"]*)"'));
  return m ? m[1] : '';
}
function has(xml, frag) { return String(xml).indexOf(frag) >= 0; }

const ROOTS = { d300: 'declaratie300', d301: 'declaratie301', d307: 'declaratie307', d311: 'declaratie311', d394: 'declaratie394', d390: 'declaratie390', d205: 'declaratie205', d112: 'D112', saft: 'AuditFile', d100: 'declaratie100', d101: 'declaratie101', intrastat: 'declaratieIntrastat' };

/** @returns { ok, errors:[], warnings:[] } */
function validateDeclaration(type, xml, ctx) {
  ctx = ctx || {};
  const errors = []; const warnings = [];
  const s = String(xml || '');

  if (!wellFormed(s)) errors.push('XML-ul nu este bine-format (antet XML lipsa sau taguri neechilibrate).');
  if (ROOTS[type] && !has(s, '<' + ROOTS[type])) warnings.push('Elementul radacina <' + ROOTS[type] + '> nu a fost gasit.');

  // CUI declarant
  const cui = (attr(s, 'cui') || ctx.cui || '').replace(/^ro/i, '').replace(/\s/g, '');
  if (!cui) errors.push('Lipseste CUI-ul declarantului.');
  else if (!/^\d{2,10}$/.test(cui)) warnings.push('CUI-ul „' + cui + '" nu pare valid (asteptam 2-10 cifre, eventual prefix RO).');

  // perioada (luna/an) acolo unde se aplica
  if (['d300', 'd301', 'd307', 'd311', 'd394', 'd390', 'd100', 'intrastat'].includes(type)) {
    if (!attr(s, 'luna') && !has(s, '<luna')) errors.push('Lipseste luna din declaratie.');
    if (!attr(s, 'an') && !has(s, '<an')) errors.push('Lipseste anul din declaratie.');
  }
  if (type === 'd205' && !attr(s, 'an') && !has(s, '<an')) errors.push('Lipseste anul din D205.');
  if (type === 'd101' && !attr(s, 'an')) errors.push('Lipseste anul din D101.');

  // Cote fara rand in schema D300 v12 (tipic: achizitii la 9%, sau date vechi la 19%/5%). Suma nu
  // are unde intra in decont, deci decontul ar fi INCOMPLET — eroare, nu avertisment. Emiterea pe
  // un rand istoric ar fi si mai rau: ANAF respinge toata declaratia.
  if (type === 'd300' && (ctx.coteFaraRand || []).length) {
    for (const c of ctx.coteFaraRand) {
      errors.push('Cota de ' + c.cota + '% (' + c.sens + ': baza ' + c.baza + ' lei, TVA ' + c.tva
        + ' lei) nu are rand in schema D300 v12 — suma nu intra in decont. Verifica incadrarea inainte de depunere.');
    }
  }

  // D394: taxarea inversa cere codul de bun art. 331 (sectiunea op11). Fara el ANAF respinge
  // declaratia, deci e eroare — dar spunem si CARE articole trebuie completate.
  if (type === 'd394' && (ctx.faraCodCategorie || []).length) {
    for (const c of ctx.faraCodCategorie) {
      errors.push('Operatiunea cu taxare inversa ' + (c.document ? '„' + c.document + '" ' : '')
        + (c.partener ? '(' + c.partener + ') ' : '') + 'nu are codul de bun art. 331 completat — '
        + 'D394 il cere (sectiunea op11) si ANAF respinge declaratia fara el.');
    }
  }

  // continut gol -> avertisment (nu eroare)
  // Elementul se numeste `<operatie`, nu `<operatiune`: ancorat pe numele gresit, avertismentul
  // „declaratie goala" iesea la FIECARE D390, inclusiv la cele pline. Un avertisment care apare
  // mereu nu mai e citit — deci ascundea exact cazul pe care trebuia sa-l semnaleze.
  if (type === 'd390' && !has(s, '<operatie ')) warnings.push('Nicio operatiune intracomunitara in perioada — declaratie goala.');
  if (type === 'd205' && !has(s, '<beneficiar ')) warnings.push('Niciun beneficiar cu retinere la sursa — declaratie goala.');
  if (type === 'd100' && attr(s, 'total_plata') === '0.00') warnings.push('Impozit 0 in trimestru — verifica daca datorezi D100 pentru perioada.');
  if (type === 'intrastat') {
    if (!has(s, '<articol ')) warnings.push('Nicio operatiune intracomunitara cu bunuri in perioada — declaratie goala.');
    if (has(s, 'codNC=""')) warnings.push('Exista articole fara cod NC8 — completeaza codurile inainte de depunere la INS.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateDeclaration, wellFormed };
