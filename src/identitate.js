'use strict';

// Identitatea persoanelor si a firmelor: CNP (patronul, persoana fizica) si CUI (firma).
// Ambele au cifra de control, deci o greseala de tastare se prinde ACUM, nu peste o luna cand
// firma s-a dublat sub un CUI aproape identic. Validarea nu inlocuieste verificarea la ANAF —
// spune doar ca sirul e format corect, nu ca titularul exista.
//
// Modul deliberat separat: `cuiKey` era o functie privata in firmeService, dar acum e nevoie de
// ea in doua locuri (cererea de acces si poarta de duplicat la creare). O singura definitie —
// altfel „acelasi CUI" ar insemna lucruri diferite in doua ecrane.

/** Cheia de comparatie a unui CUI: fara prefix RO, fara spatii/puncte, majuscule. */
function cuiKey(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/^RO/, '').replace(/[^0-9A-Z]/g, '');
}

// Cifra de control a CUI-ului romanesc: ponderi 7 5 3 2 1 7 5 3 2, aliniate la DREAPTA fata de
// cifrele dinaintea ultimei; restul inmultit cu 10 modulo 11, iar 10 se citeste 0.
const CUI_W = [7, 5, 3, 2, 1, 7, 5, 3, 2];
/** CUI romanesc valid ca format (2..10 cifre + cifra de control corecta). */
function validCUI(v) {
  const k = cuiKey(v);
  if (!/^[0-9]{2,10}$/.test(k)) return false;
  const cifre = k.split('').map(Number);
  const ctrl = cifre.pop();
  const w = CUI_W.slice(CUI_W.length - cifre.length); // aliniere la dreapta
  const suma = cifre.reduce((s, c, i) => s + c * w[i], 0);
  return ((suma * 10) % 11) % 10 === ctrl;
}

// Cifra de control a CNP-ului: constanta 279146358279, restul modulo 11, iar 10 se citeste 1.
const CNP_W = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
/** Normalizeaza un CNP pentru stocare/comparatie: doar cifrele. */
function cnpKey(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
/**
 * CNP romanesc valid: 13 cifre, sex/secol 1..8 (9 = rezident strain), data nasterii plauzibila
 * si cifra de control corecta. Codul de judet (pozitiile 8-9) NU se verifica: lista s-a schimbat
 * in timp, iar un CNP legitim emis dupa o reorganizare ar fi respins pe nedrept.
 */
function validCNP(v) {
  const k = cnpKey(v);
  if (!/^[1-9][0-9]{12}$/.test(k)) return false;
  const s = Number(k[0]);
  const secol = s === 1 || s === 2 ? 1900 : s === 3 || s === 4 ? 1800 : s === 5 || s === 6 ? 2000 : null;
  const an = Number(k.slice(1, 3));
  const luna = Number(k.slice(3, 5));
  const zi = Number(k.slice(5, 7));
  if (luna < 1 || luna > 12 || zi < 1 || zi > 31) return false;
  if (secol) {
    // data trebuie sa existe cu adevarat (31 februarie nu e o data)
    const dt = new Date(Date.UTC(secol + an, luna - 1, zi));
    if (dt.getUTCMonth() !== luna - 1 || dt.getUTCDate() !== zi) return false;
  }
  const suma = CNP_W.reduce((acc, w, i) => acc + w * Number(k[i]), 0);
  const rest = suma % 11;
  return (rest === 10 ? 1 : rest) === Number(k[12]);
}

/**
 * CNP mascat pentru afisare: primele 7 cifre (sex + data nasterii, oricum deduse din varsta),
 * restul ascuns. Proprietarul isi recunoaste codul, dar o captura de ecran nu il divulga.
 * Ultimele cifre NU se arata: cu ele si cu primele 7 ar mai ramane 4 necunoscute, adica un
 * spatiu de cautare de 10.000 — prea putin pentru un identificator care nu se schimba niciodata.
 */
function maskCNP(v) {
  const k = cnpKey(v);
  if (k.length !== 13) return '';
  return k.slice(0, 7) + '******';
}

module.exports = { cuiKey, validCUI, cnpKey, validCNP, maskCNP };
