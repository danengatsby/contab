'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  SECRETELE OBLIGATORII LA PORNIRE
//
//  Doua chei nu au voie sa lipseasca pe o instalare reala:
//   - CONTAB_AUTH_SECRET  — semneaza cookie-urile de sesiune SI deriva token-ul CSRF. Fara ea,
//     codul cade pe `settings.authSecret`, generat automat si stocat IN BAZA. Consecinta: cine
//     obtine o copie a bazei (un backup, un dump) poate FORJA sesiuni de admin. Backup-ul devine
//     echivalentul parolei.
//   - CONTAB_SECRETS_KEY  — cripteaza secretele stocate (credentiale SPV, chei de plata). Fara ea,
//     `secretbox.seal()` intoarce textul NEATINS, tacut: crezi ca ai criptare, dar backup-ul
//     contine credentiale vii.
//
//  DE CE FAIL-CLOSED, si nu „doar in productie": marcajul de productie ar trebui sa fie el insusi
//  prezent ca sa functioneze garda. Pe aceasta instalare `NODE_ENV` NU e setat in mediul pm2 —
//  o garda `if (NODE_ENV === 'production')` n-ar fi pornit niciodata exact unde conteaza, si am fi
//  crezut ca suntem aparati. Deci: lipsa secretelor opreste pornirea ORIUNDE, iar dezvoltarea si
//  testele spun EXPLICIT ca sunt dezvoltare (`CONTAB_DEV=1`). Daca uiti flagul in dezvoltare,
//  primesti o eroare limpede; daca-l uiti in productie, serverul tot refuza sa porneasca.
//  Ambele esecuri sunt sigure — spre deosebire de varianta „presupunem ca nu e productie".
//
//  Se verifica si FORMATUL, nu doar prezenta: o cheie de 8 caractere sau un CONTAB_SECRETS_KEY
//  care nu e 64 hex sunt la fel de rele ca absenta — a doua chiar dezactiveaza criptarea tacut
//  (keyFrom() intoarce null pe orice nu se potriveste cu /^[0-9a-f]{64}$/).
// ─────────────────────────────────────────────────────────────────────────────

const MIN_AUTH = 32; // caractere; cheia semneaza HMAC-uri de sesiune

/** Problemele gasite in mediul dat. Functie PURA (primeste env), ca sa fie testabila. */
function problems(env) {
  const e = env || {};
  const out = [];
  const auth = String(e.CONTAB_AUTH_SECRET || '').trim();
  if (!auth) {
    out.push('CONTAB_AUTH_SECRET lipseste — sesiunile s-ar semna cu un secret generat si stocat IN BAZA, '
      + 'deci oricine obtine un backup poate forja sesiuni de admin.');
  } else if (auth.length < MIN_AUTH) {
    out.push('CONTAB_AUTH_SECRET e prea scurt (' + auth.length + ' caractere, minim ' + MIN_AUTH + ').');
  }
  const box = String(e.CONTAB_SECRETS_KEY || '').trim();
  if (!box) {
    out.push('CONTAB_SECRETS_KEY lipseste — secretele stocate (credentiale SPV, chei de plata) ar ramane '
      + 'NECRIPTATE, tacut: seal() intoarce textul neatins cand cheia lipseste.');
  } else if (!/^[0-9a-f]{64}$/i.test(box)) {
    out.push('CONTAB_SECRETS_KEY nu e 64 de caractere hexazecimale — criptarea se dezactiveaza TACUT '
      + '(cheia e ignorata daca nu se potriveste exact).');
  }
  return out;
}

/** Textul afisat la refuz (si in teste). Separat de `assert`, ca sa poata fi verificat fara process.exit. */
function report(list) {
  return ['', 'PORNIRE REFUZATA — secrete obligatorii lipsa sau invalide:', '']
    .concat(list.map((p) => '  • ' + p))
    .concat([
      '',
      'Genereaza-le si pune-le in .env (ambele, 64 hex):',
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      '',
      'ATENTIE la CONTAB_AUTH_SECRET pe o instalare EXISTENTA: schimbarea lui invalideaza toate',
      'sesiunile active (toata lumea se re-autentifica). Pe una noua, pune-l inainte de primul login.',
      'CONTAB_SECRETS_KEY se roteste cu CONTAB_SECRETS_KEY_OLD setat (vezi src/secretbox.js).',
      '',
      'Dezvoltare sau teste? Spune-o EXPLICIT: CONTAB_DEV=1 (atunci se accepta valorile de rezerva,',
      'cu avertisment la fiecare pornire). Flagul nu se pune niciodata pe instalarea reala.',
      '',
    ]).join('\n');
}

/**
 * Verifica secretele la pornire. In dezvoltare (`CONTAB_DEV=1`) doar avertizeaza.
 * @param {object} [env] mediul (implicit process.env)
 * @param {object} [io] { log, error, exit } — injectabile pentru teste
 */
let verificat = false;
/** Reseteaza starea (doar pentru teste — in productie garda ruleaza o data pe proces). */
function _reset() { verificat = false; }

function assertSecrets(env, io) {
  // Apelabila din doua locuri (server.js, imediat dupa .env; si lifecycle.start, ca plasa pentru
  // orice alt punct de intrare) — a doua oara nu mai spune nimic.
  if (verificat) return { ok: true, dev: false, problems: [], repetat: true };
  verificat = true;
  const e = env || process.env;
  const o = io || {};
  const error = o.error || console.error;
  const log = o.log || console.warn;
  const exit = o.exit || ((c) => process.exit(c));
  const list = problems(e);
  if (!list.length) return { ok: true, dev: false, problems: [] };
  if (String(e.CONTAB_DEV || '') === '1') {
    log('[contab] DEZVOLTARE (CONTAB_DEV=1): pornire cu secrete de rezerva — ' + list.length
      + ' problema/probleme. NU folosi asa in productie.');
    for (const p of list) log('  • ' + p);
    return { ok: true, dev: true, problems: list };
  }
  error(report(list));
  exit(1);
  return { ok: false, dev: false, problems: list };
}

module.exports = { problems, report, assertSecrets, MIN_AUTH, _reset };
