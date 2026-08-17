// Shim DOM minim pentru testarea modulelor de frontend in Node, FARA jsdom (fidel filozofiei
// zero-dependinte a proiectului). Ofera exact globalii pe care modulele din public/ ii ating la
// IMPORT (document, window, MutationObserver, navigator, location, localStorage) — nu simuleaza
// randarea. Testam functiile PURE si construirea de HTML (siruri), nu comportamentul in pagina.
//
// Se importa PRIMUL in test/frontend.mjs: in ESM, un import cu efect secundar se evalueaza inainte
// de modulele importate dupa el, deci globalii sunt setati inainte ca public/core.js sa fie evaluat.

const noop = () => {};
const classList = () => ({ add: noop, remove: noop, toggle: noop, contains: () => false });
// Cautarile intorc MEREU un element inert, niciodata null: la import, modulele din public/ isi
// leaga ascultatorii de evenimente pe elementele paginii, iar disciplina de garda pe null nu e
// uniforma (`public/plan.js` face direct `$('#planFilter').addEventListener(...)`). Un stub inert
// face orice modul importabil fara sa cerem cod de productie defensiv doar de dragul testelor.
// `options`/`files`/`children` sunt iterabile, ca `[...el.options]` sa nu arunce.
function stubEl() {
  const el = {
    addEventListener: noop, removeEventListener: noop, appendChild: noop, removeChild: noop, remove: noop,
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop, insertAdjacentHTML: noop,
    querySelectorAll: () => [], closest: () => null, classList: classList(), dataset: {}, style: {},
    children: [], files: [], options: [], value: '', textContent: '', innerHTML: '', className: '',
    checked: false, disabled: false, focus: noop, blur: noop, click: noop, dispatchEvent: noop, reset: noop,
  };
  el.querySelector = () => stubEl();
  // Un formular real isi expune controalele ca proprietati dupa `name` (`$('#f').tip`), iar
  // shim-ul nu are de unde sti numele. Proxy-ul intoarce un element inert pentru orice
  // proprietate necunoscuta, ca modulele sa se poata incarca.
  // EXCEPTIILE conteaza: `then` ar face obiectul „thenable" si ar bloca orice `await`; `length`
  // si `nodeType` sunt citite ca numere; simbolurile trebuie sa ramana nedefinite (iterare,
  // instanceof). Pentru ele intoarcem undefined, ca in obiectul de baza.
  const OPAC = new Set(['then', 'length', 'nodeType', 'constructor', 'toJSON', 'inspect']);
  return new Proxy(el, {
    get(t, k) {
      if (k in t || typeof k === 'symbol' || OPAC.has(k)) return t[k];
      return stubEl();
    },
  });
}

globalThis.document = {
  querySelector: () => stubEl(),
  querySelectorAll: () => [],
  getElementById: () => stubEl(),
  createElement: () => stubEl(),
  documentElement: stubEl(),
  body: stubEl(),
  addEventListener: noop,
};
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
// navigator e definit nativ de Node (>=21) ca proprietate DOAR-citire: atribuirea simpla arunca
// TypeError, deci il inlocuim prin defineProperty. Fara 'serviceWorker' -> inregistrarea PWA se sare.
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
globalThis.location = { protocol: 'http:', hostname: 'localhost' };

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// sessionStorage are `length` + `key(i)`: ciornele de formular se sterg parcurgand cheile
// dupa prefix, deci un shim doar cu get/set/remove n-ar putea dovedi golirea.
const sessionStore = new Map();
globalThis.sessionStorage = {
  get length() { return sessionStore.size; },
  key: (i) => (Array.from(sessionStore.keys())[i] ?? null),
  getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
  setItem: (k, v) => sessionStore.set(k, String(v)),
  removeItem: (k) => sessionStore.delete(k),
};
