'use strict';

// ANALIZA STATICA — ce `node --check` nu poate face.
//
// `npm run lint` rula pana acum doar `scripts/check-syntax.js`, adica `node --check`: verifica
// exclusiv ca fisierul PARSEAZA. Pe ~45.000 de linii de JavaScript fara tipuri, nimic nu prindea
// variabile nefolosite, nume nedefinite (o greseala de tastare intr-o ramura rar atinsa),
// declaratii duplicate sau conditii moarte. Aici se acopera exact acele clase.
//
// DE CE NU E IN `npm test`: `npm test` ruleaza la `prestart`, deci pe SERVERUL DE PRODUCTIE, la
// fiecare pornire. ESLint e o dependinta de dezvoltare — cu `npm ci --omit=dev` nici n-ar exista
// acolo, iar `npm test` ar pica, adica un linter ar putea impiedica pornirea aplicatiei de
// contabilitate. Se ruleaza in CI si local, prin `npm run lint`.
//
// Cele trei medii sunt SEPARATE fiindca globalele difera: `require`/`module` in src/, `window`/
// `document` in public/, `self`/`caches` in service worker. Un singur bloc ar fi insemnat ori
// `no-undef` oprit (deci poarta inutila), ori zgomot permanent.

const js = require('@eslint/js');
const globals = require('globals');

// Reguli comune. Perimetrul e deliberat INGUST: clase de defecte reale, nu stil. Formatarea nu se
// impune — codul e deja consecvent, iar o regula de stil ar produce mii de semnalari care ar
// ingropa singurele care conteaza.
const reguli = {
  ...js.configs.recommended.rules,
  // Argumentele nefolosite sunt frecvent intentionate (semnatura ceruta de Express: `next`,
  // callback-uri cu `(err, res)`). Se semnaleaza doar cele de DUPA ultimul folosit, iar prefixul
  // `_` sau numele conventionale de „ignora" scutesc explicit.
  'no-unused-vars': ['error', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    // Legarea nefolosita dintr-un `catch` NU e semnal: pe caile best-effort codul scrie si
    // `catch (e)`, si `catch (_)`, iar diferenta n-a produs niciodata un defect. Cu 'all' ar fi
    // insemnat 103 modificari mecanice — inclusiv in generatoare fiscale — pentru zero informatie,
    // adica exact genul de zgomot care ingroapa semnalarile care conteaza. Regula ramane activa
    // pentru VARIABILE si IMPORTURI, unde a si gasit 34 de bucati de cod mort.
    caughtErrors: 'none',
  }],
  // `catch (_) {}` gol e un tipar DELIBERAT si des in acest cod (best-effort: chmod, unlink,
  // cleanup). Blocurile goale de alt fel raman semnalate.
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Caracterele de control in expresii regulate sunt INTENTIA, nu o greseala: `src/sepa.js`,
  // `src/xml.js`, `src/dbf.js` si `src/messages.js` le sterg tocmai ca sa nu ajunga in fisiere
  // care pleaca la BANCA sau la ANAF. Regula ar semnala exact codul care face lucrul corect.
  'no-control-regex': 'off',
  // BOM-ul (U+FEFF) si spatiul neseparator (U+00A0) apar INTENTIONAT in expresii regulate:
  // `plan.js`/`migrare.js` curata BOM-ul din CSV-urile importate, iar `extractor.js` normalizeaza
  // spatiile din textul extras din PDF. In siruri si regexuri sunt date, nu formatare.
  'no-irregular-whitespace': ['error', { skipRegExps: true, skipStrings: true }],
};

module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'logs/**', 'schemas/**', 'public/tools/**'] },

  // Node, CommonJS: nucleul aplicatiei, scripturile si suitele sincrone.
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'server.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: reguli,
  },

  // Node, module ES: probele de frontend (`test/*.mjs`) si orice script .mjs.
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: reguli,
  },

  // Browser, module ES: interfata. `public/package.json` NU exista intentionat (ar fi servit
  // static), deci tipul de modul se declara aici, nu prin fisier.
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules: reguli,
  },

  // Scripturile care CONDUC UN BROWSER (E2E, capturi de marketing): corpul callback-urilor
  // `page.evaluate(...)` se executa IN PAGINA, deci `document`/`window` sunt globale reale acolo,
  // nu greseli. Tiparul acopera orice script de conducere, nu doar cele numite `e2e`:
  // `capturi-marketing.mjs` a fost adaugat mai tarziu si a picat exact pe aceasta lipsa — iar
  // `npm test` nu l-a prins, fiindca ESLint ruleaza doar in CI si local (vezi antetul).
  {
    files: ['scripts/e2e*.mjs', 'scripts/capturi-marketing.mjs', 'scripts/video-prezentare.mjs'],
    // `goTab` e o globala REALA a aplicatiei (public/app.js: `window.goTab = goTab`), pusa acolo
    // tocmai ca sa poata fi condusa din afara. Verificat inainte de a o declara — altfel ar fi
    // fost un ReferenceError in pagina, la trei pasi din E2E.
    languageOptions: { globals: { ...globals.node, ...globals.browser, goTab: 'readonly' } },
  },

  // `PANEL_INFO` e declarat cu `var` in public/panel-info.js, incarcat ca script NON-modul inaintea
  // lui app.js — deci chiar e o globala pe `window` (un `const` la nivel superior N-AR fi fost).
  {
    files: ['public/app.js'],
    languageOptions: { globals: { PANEL_INFO: 'readonly' } },
  },

  // `public/panel-info.js` e incarcat ca script NON-modul si EXISTA ca sa publice `PANEL_INFO`
  // pentru app.js. In propriul fisier pare nefolosit — exact ce face un modul de constante globale.
  {
    files: ['public/panel-info.js'],
    languageOptions: { sourceType: 'script' },
    rules: { 'no-unused-vars': 'off' },
  },

  // Service worker: alt set de globale (`self`, `caches`, `clients`) — fara el, sw.js ar fi
  // aparut plin de `no-undef` false.
  {
    files: ['public/sw.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.serviceworker } },
    rules: reguli,
  },
];
