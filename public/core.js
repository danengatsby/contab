'use strict';
// Nucleu partajat al interfetei: helperi fara stare + starea globala (META/USER).
// Importat de app.js si, pe masura extragerii pe functionalitati, de restul modulelor.
// Live-binding ES: importatorii vad MEREU valoarea curenta a lui META/USER; reasignarea se
// face DOAR prin setMeta/setUser (un import nu poate fi reasignat din alt modul).

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const fmt = (n) => (Number(n) || 0).toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Rotunjire la 2 zecimale (bani), aceeasi semantica cu src/util.js. Folosita in stocuri
// (total valoare stoc) si la auto-completarea salariilor — lipsea din frontend (ReferenceError).
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Escapare HTML pentru datele de provenienta externa (parteneri din e-Factura/SPV, extrase
// bancare, denumiri, explicatii) inainte de interpolarea in innerHTML — al doilea strat de
// aparare dupa CSP. `H` = escapare completa (text + atribute), folosita la randare.
export const H = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Varianta usoara (doar & < >) + varianta pentru atribute (adauga escaparea ghilimelelor).
// Partajate: mesageria le foloseste la randarea firului, iar app.js la galeriile de documente.
export const escMsg = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const escAttr = (s) => escMsg(s).replace(/"/g, '&quot;');

export let META = { types: [], accounts: [], company: {}, periods: [] };
export let USER = {};
export function setMeta(m) { META = m; }
export function setUser(u) { USER = u; }

export const accName = (c) => { const a = META.accounts.find((x) => x.cod === String(c)); return a ? a.nume : ''; };
// Contul demo (public, partajat): unele UI-uri se ascund. Partajat de app.js si admin.js.
export const isDemo = () => !!(USER && USER.username === 'demo');

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

// Citeste un fisier de import: .xlsx/.xls/.dbf -> convertit la CSV pe server; .csv -> citit direct.
// Partajat de importurile de parteneri, produse, stoc initial si plan de conturi.
export async function fileToCsv(file) {
  if (/\.(xlsx|xls|dbf)$/i.test(file.name)) {
    const fd = new FormData(); fd.append('file', file);
    const r = await api('/api/xlsx-to-csv', { method: 'POST', body: fd });
    return r.csv || '';
  }
  return await file.text();
}
