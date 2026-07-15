'use strict';
// Nucleu partajat al interfetei: helperi fara stare + starea globala (META/USER).
// Importat de app.js si, pe masura extragerii pe functionalitati, de restul modulelor.
// Live-binding ES: importatorii vad MEREU valoarea curenta a lui META/USER; reasignarea se
// face DOAR prin setMeta/setUser (un import nu poate fi reasignat din alt modul).

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const fmt = (n) => (Number(n) || 0).toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Escapare HTML pentru datele de provenienta externa (parteneri din e-Factura/SPV, extrase
// bancare, denumiri, explicatii) inainte de interpolarea in innerHTML — al doilea strat de
// aparare dupa CSP. `H` = escapare completa (text + atribute), folosita la randare.
export const H = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export let META = { types: [], accounts: [], company: {}, periods: [] };
export let USER = {};
export function setMeta(m) { META = m; }
export function setUser(u) { USER = u; }

export const accName = (c) => { const a = META.accounts.find((x) => x.cod === String(c)); return a ? a.nume : ''; };

export function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  setTimeout(() => (t.className = 'toast'), 3200);
}

let pendingReq = 0;
export function setLoad(on) {
  pendingReq = Math.max(0, pendingReq + (on ? 1 : -1));
  const b = document.getElementById('loadbar');
  if (b) b.classList.toggle('on', pendingReq > 0);
}

// Hook optional pentru raspunsul 402 (proba firmei expirata): inregistrat de app.js (setOn402),
// ca sa nu legam nucleul de UI-ul de abonare (promptFirmaSubscribe).
let on402TrialExpired = null;
export function setOn402(fn) { on402TrialExpired = fn; }

export async function api(url, opts) {
  setLoad(true);
  try {
    const r = await fetch(url, opts);
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) {
      // Firma de proba expirata: propune abonarea in loc de o simpla eroare
      if (r.status === 402 && data && data.firmaTrialExpired && on402TrialExpired) on402TrialExpired(data);
      const err = new Error((data && data.error) || ('Eroare ' + r.status)); err.status = r.status; err.data = data; throw err;
    }
    return data;
  } finally { setLoad(false); }
}
