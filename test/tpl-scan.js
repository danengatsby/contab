'use strict';

// Scaner de TEMPLATE LITERALE pentru portile de escapare (HTML in test/frontend.mjs, XML in
// test/run.js). Exista fiindca ambele porti erau ancorate PE LINIE: o interpolare se verifica
// doar daca linia ei contine `<tag` (sau innerHTML). Intr-un template pe mai multe randuri —
// forma normala in acest cod — liniile de continuare nu contin niciun tag, deci scapau neatinse.
// Masurat inainte de schimbare: 6% dintre interpolarile din public/ si 28% dintre cele din
// generatoarele XML stateau pe linii nescanate (20 dintre ele chiar cu nume de camp riscant,
// toate escapate corect — gaura era reala, dar goala; disciplina tinuse, nu poarta).
//
// De ce un scaner si nu un parser: proiectul are dependinte minime si nu exista parser JS
// disponibil (nici macar tranzitiv). Scanerul nu trebuie sa inteleaga JS, doar sa stie unde
// incepe si se termina un template — deci sare comentariile, sirurile obisnuite si literalii
// REGEX. Regexurile conteaza: o prima versiune care nu-i trata a raportat ZERO template-uri in
// src/sepa.js (fisier plin de ele) si ar fi dat un „totul e curat" fals.
//
// Ambiguitatea `/` (impartire vs regex) se rezolva cu euristica standard: un `/` incepe un regex
// doar cand ultimul token semnificativ dinainte cere un operand.

const PREV_OK = new Set(['=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'new']);

function regexAllowed(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  if (j < 0) return true;
  if (PREV_OK.has(src[j])) return true;
  const end = j + 1;
  while (j >= 0 && /[\w$]/.test(src[j])) j -= 1;
  return KEYWORDS.has(src.slice(j + 1, end));
}

// Sare un template imbricat (aflat in interiorul unei interpolari), cu tot cu interpolarile lui.
function skipNestedTemplate(src, k) {
  const n = src.length;
  let depth = 0;
  k += 1;
  while (k < n) {
    if (src[k] === '\\') { k += 2; continue; }
    if (src[k] === '$' && src[k + 1] === '{') { depth += 1; k += 2; continue; }
    if (src[k] === '}' && depth > 0) depth -= 1;
    else if (src[k] === '`' && depth === 0) break;
    k += 1;
  }
  return k + 1;
}

/**
 * Intoarce template literalele de nivel superior din `src`:
 *   [{ line, text, interps: [{ line, expr }] }]
 * `interps` contine doar interpolarile FRUNZA (fara alt `${` inauntru) — cele care chiar ajung
 * in iesire; expresia exterioara a unui template imbricat e deja acoperita de propriile frunze.
 */
function templates(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  const lineAt = (p) => {
    let c = 1;
    for (let k = 0; k < p; k += 1) if (src[k] === '\n') c += 1;
    return c;
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i); i = j < 0 ? n : j + 2; continue; }
    if (c === '/' && regexAllowed(src, i)) {
      let j = i + 1; let inClass = false; let ok = false;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { ok = true; break; }
        else if (src[j] === '\n') break; // un regex nu trece de capatul liniei -> nu era regex
        j += 1;
      }
      if (ok) { i = j + 1; continue; }
    }
    if (c === '"' || c === "'") {
      const q = c; i += 1;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
      i += 1; continue;
    }
    if (c === '`') {
      const start = i;
      const interps = [];
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') break;
        if (src[i] === '$' && src[i + 1] === '{') {
          const cur = i + 2;
          let depth = 1; let j = cur;
          while (j < n && depth > 0) {
            if (src[j] === '\\') { j += 2; continue; }
            if (src[j] === '`') { j = skipNestedTemplate(src, j); continue; }
            if (src[j] === '{') depth += 1;
            else if (src[j] === '}') { depth -= 1; if (depth === 0) break; }
            j += 1;
          }
          interps.push({ line: lineAt(cur), expr: src.slice(cur, j) });
          i = j + 1;
          continue;
        }
        i += 1;
      }
      out.push({ line: lineAt(start), text: src.slice(start, i + 1), interps });
      i += 1; continue;
    }
    i += 1;
  }
  return out;
}

/** Interpolarile FRUNZA din template-urile care contin markup (`tagRx`), ca lista plata. */
function markupInterps(src, tagRx) {
  const out = [];
  for (const t of templates(src)) {
    if (!tagRx.test(t.text)) continue;
    for (const it of t.interps) {
      if (it.expr.includes('${')) continue; // nu e frunza
      const e = it.expr.trim();
      if (e) out.push({ line: it.line, expr: e });
    }
  }
  return out;
}

module.exports = { templates, markupInterps };
