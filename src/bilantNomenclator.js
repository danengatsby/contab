'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  NOMENCLATOARELE ANTETULUI DE BILANT (S1120 / S1121)
//
//  Valorile NU sunt alese de noi: sunt extrase din validatorul OFICIAL ANAF
//  (`Parameters_v0.class`, campurile `_judete1`, `_formeProp`, `_calit`). Orice valoare
//  din afara listelor de aici e respinsa la depunere cu „nu se afla in lista".
//
//  Lista de judete e in ordine ALFABETICA, dar cu codurile ISTORICE — de aceea Calarasi (51)
//  si Giurgiu (52) apar intercalate, nu la coada. Ordinea din `JUDETE` reproduce exact ordinea
//  din validator, deci imperecherea cu codurile ISO 3166-2:RO folosite deja de aplicatie
//  (`firma.judet` = 'RO-B', 'RO-CJ'…) e pozitionala si verificabila.
// ─────────────────────────────────────────────────────────────────────────────

// [cod ANAF, cod ISO, denumire] — ordinea e cea din validator (`_judete1`, 42 de intrari).
const JUDETE = [
  ['01', 'RO-AB', 'Alba'], ['02', 'RO-AR', 'Arad'], ['03', 'RO-AG', 'Arges'],
  ['04', 'RO-BC', 'Bacau'], ['05', 'RO-BH', 'Bihor'], ['06', 'RO-BN', 'Bistrita-Nasaud'],
  ['07', 'RO-BT', 'Botosani'], ['08', 'RO-BV', 'Brasov'], ['09', 'RO-BR', 'Braila'],
  ['10', 'RO-BZ', 'Buzau'], ['11', 'RO-CS', 'Caras-Severin'], ['51', 'RO-CL', 'Calarasi'],
  ['12', 'RO-CJ', 'Cluj'], ['13', 'RO-CT', 'Constanta'], ['14', 'RO-CV', 'Covasna'],
  ['15', 'RO-DB', 'Dambovita'], ['16', 'RO-DJ', 'Dolj'], ['17', 'RO-GL', 'Galati'],
  ['52', 'RO-GR', 'Giurgiu'], ['18', 'RO-GJ', 'Gorj'], ['19', 'RO-HR', 'Harghita'],
  ['20', 'RO-HD', 'Hunedoara'], ['21', 'RO-IL', 'Ialomita'], ['22', 'RO-IS', 'Iasi'],
  ['23', 'RO-IF', 'Ilfov'], ['24', 'RO-MM', 'Maramures'], ['25', 'RO-MH', 'Mehedinti'],
  ['26', 'RO-MS', 'Mures'], ['27', 'RO-NT', 'Neamt'], ['28', 'RO-OT', 'Olt'],
  ['29', 'RO-PH', 'Prahova'], ['30', 'RO-SM', 'Satu Mare'], ['31', 'RO-SJ', 'Salaj'],
  ['32', 'RO-SB', 'Sibiu'], ['33', 'RO-SV', 'Suceava'], ['34', 'RO-TR', 'Teleorman'],
  ['35', 'RO-TM', 'Timis'], ['36', 'RO-TL', 'Tulcea'], ['37', 'RO-VS', 'Vaslui'],
  ['38', 'RO-VL', 'Valcea'], ['39', 'RO-VN', 'Vrancea'], ['40', 'RO-B', 'Bucuresti'],
];

const COD_JUDET = new Set(JUDETE.map((j) => j[0]));
const ISO_TO_COD = new Map(JUDETE.map((j) => [j[1], j[0]]));

/** Codul ANAF de judet pornind de la `firma.judet` (ISO 3166-2:RO). Null daca nu se poate deduce —
 *  NU se ghiceste un implicit: un judet gresit in antet e o declaratie gresita, nu o nuanta. */
function codJudet(iso) {
  return ISO_TO_COD.get(String(iso || '').toUpperCase().trim()) || null;
}

// Forma de proprietate (`_formeProp`, 27 de valori). Denumirile sunt cele din clasificarea INS;
// pentru firmele obisnuite (SRL cu capital privat autohton) valoarea uzuala e 35.
const FORME_PROPRIETATE = [
  ['11', 'Regii autonome'], ['12', 'Societati comerciale cu capital integral de stat'],
  ['13', 'Alte unitati economice de stat'], ['14', 'Societati comerciale cu capital de stat autohton'],
  ['15', 'Societati comerciale cu capital de stat si strain'], ['16', 'Alte forme cu capital de stat'],
  ['21', 'Societati comerciale cu capital mixt (stat si privat)'],
  ['22', 'Societati comerciale cu capital mixt (stat si strain)'],
  ['23', 'Societati comerciale cu capital mixt (privat si strain)'],
  ['24', 'Societati comerciale pe actiuni'], ['25', 'Societati in nume colectiv'],
  ['26', 'Societati in comandita simpla'], ['27', 'Societati in comandita pe actiuni'],
  ['28', 'Societati cu raspundere limitata'], ['29', 'Alte societati cu capital mixt'],
  ['31', 'Societati cu capital integral strain'], ['32', 'Sucursale ale societatilor straine'],
  ['33', 'Organizatii cooperatiste mestesugaresti'], ['34', 'Organizatii cooperatiste de consum'],
  ['35', 'Societati comerciale cu capital privat autohton'],
  ['36', 'Organizatii cooperatiste de credit'], ['37', 'Alte organizatii cooperatiste'],
  ['41', 'Persoane fizice autorizate / intreprinderi individuale'],
  ['42', 'Asociatii familiale'], ['43', 'Asociatii si fundatii'],
  ['44', 'Alte forme de organizare fara scop patrimonial'], ['50', 'Alte forme de proprietate'],
];
const COD_FORMA = new Set(FORME_PROPRIETATE.map((f) => f[0]));

// Calitatea celui care intocmeste situatiile (`_calit`, 5 valori). REGULA R26 a validatorului:
// pentru 21 si 22 (persoane cu drept de semnatura din afara entitatii) numarul de inregistrare
// in Registrul CECCAR e OBLIGATORIU; pentru 11/12/13 trebuie sa LIPSEASCA.
const CALITATI = [
  ['11', 'Director economic'], ['12', 'Contabil-sef'], ['13', 'Alta persoana imputernicita'],
  ['21', 'Expert contabil / contabil autorizat (persoana fizica)'],
  ['22', 'Societate membra CECCAR'],
];
const COD_CALITATE = new Set(CALITATI.map((c) => c[0]));
/** Calitatile pentru care validatorul CERE numarul din Registrul CECCAR (regula R26). */
const CALITATI_CU_NR = new Set(['21', '22']);

// Statutul de audit (`d_audit`): intreg 1..3. Pentru 3 (neauditat) validatorul cere denumirea
// completata, dar NU accepta numar de inregistrare si nici CIF de auditor.
const AUDIT = [
  ['1', 'Auditate de auditor financiar'],
  ['2', 'Verificate de cenzori'],
  ['3', 'Neauditate / neverificate'],
];
const COD_AUDIT = new Set(AUDIT.map((a) => a[0]));

/** Optiunile pentru interfata (perechi valoare/eticheta), intr-un singur obiect. */
function optiuni() {
  return {
    judete: JUDETE.map(([cod, iso, nume]) => ({ cod, iso, nume })),
    formeProprietate: FORME_PROPRIETATE.map(([cod, nume]) => ({ cod, nume })),
    calitati: CALITATI.map(([cod, nume]) => ({ cod, nume, cereNr: CALITATI_CU_NR.has(cod) })),
    audit: AUDIT.map(([cod, nume]) => ({ cod, nume })),
  };
}

module.exports = {
  JUDETE, FORME_PROPRIETATE, CALITATI, AUDIT,
  COD_JUDET, COD_FORMA, COD_CALITATE, COD_AUDIT, CALITATI_CU_NR,
  codJudet, optiuni,
};
