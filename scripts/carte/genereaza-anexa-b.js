// ANEXA B — monografii, generate DIN APLICATIE: fiecare articol e iesirea reala a lui
// `build()` din src/documentTypes/, pe valori de proba. Nu se scrie de mana.
const fs = require('fs');
const path = require('path');
const dt = require(path.join(__dirname, '../../src/documentTypes'));
const coa = require(path.join(__dirname, '../../src/chartOfAccounts'));
const fiscal = require(path.join(__dirname, '../../src/fiscal'));

const TIPURI = Object.values(dt).find(Array.isArray) || dt;
const COTA = fiscal.FISCAL.tvaStandard;

// Valori de proba, alese ca sa dea cifre rotunde si articole complete.
const BAZA = 10000, TVA = Math.round(BAZA * COTA) / 100;
function probe(t) {
  const d = {};
  for (const f of (t.fields || [])) {
    if (f.default !== undefined) { d[f.name] = f.default; continue; }
    switch (f.type) {
      case 'date': d[f.name] = '2026-06-15'; break;
      case 'number': d[f.name] = 0; break;
      case 'checkbox': d[f.name] = false; break;
      default: d[f.name] = ''; break;
    }
  }
  // campurile de bani, umplute cu valori care produc articole lizibile
  const set = (k, v) => { if (k in d) d[k] = v; };
  set('baza', BAZA); set('valoare', BAZA); set('suma', BAZA); set('cost', BAZA);
  set('pret', BAZA); set('brut', 5000); set('cota', COTA); set('tva', TVA);
  set('principal', BAZA); set('dobanda', 500); set('adaos', 2000);
  set('amortizare', 3000); set('valoareImputata', BAZA); set('cantitate', 10);
  set('cas', 1250); set('cass', 500); set('impozit', 325); set('cam', 112.5);
  set('net', 2968); set('numerar', BAZA); set('curs', 5); set('valoareFinantata', BAZA);
  set('marja', 2000); set('valoareReziduala', 1000); set('sumaValuta', 2000);
  set('valoareBunuri', BAZA); set('taxeVamale', 500); set('pretVanzare', 12000);
  set('pretAchizitie', BAZA); set('valoareContabila', BAZA); set('plus', 500); set('minus', 300);
  set('diferenta', 500); set('comision', 25); set('valoareImobilizare', BAZA);
  return d;
}


// Titlurile din cod sunt fara diacritice (conventia din src/). In carte se scriu corect —
// dar NUMAI titlul: conturile, sumele si numarul de linii raman iesirea lui build().
const TITLU = {
  factura_cumparare_marfuri: 'Factură de cumpărare mărfuri',
  factura_cumparare_materii: 'Factură de cumpărare materii prime și materiale',
  factura_servicii_primita: 'Factură de servicii primită (chirie, telecom, onorarii)',
  factura_utilitati: 'Factură de utilități (energie, apă)',
  factura_imobilizare: 'Factură de achiziție a unui mijloc fix',
  achizitie_intracomunitara: 'Achiziție intracomunitară de bunuri (taxare inversă)',
  import_vamal: 'Import de bunuri din afara Uniunii (declarație vamală)',
  taxare_inversa_interna_achizitie: 'Achiziție cu taxare inversă internă (art. 331)',
  combustibil_50: 'Combustibil cu TVA deductibilă 50% (vehicul cu folosință limitată)',
  factura_storno_cumparare: 'Factură de corecție primită (storno în roșu)',
  factura_vanzare_marfuri: 'Factură de vânzare mărfuri (cu descărcarea gestiunii)',
  factura_vanzare_servicii: 'Factură de prestări servicii emisă',
  factura_vanzare_produse: 'Factură de vânzare produse finite',
  bon_fiscal_z: 'Raport Z — vânzare cu amănuntul în numerar',
  livrare_intracomunitara: 'Livrare intracomunitară de bunuri (scutită)',
  export_extracomunitar: 'Export de bunuri în afara Uniunii (scutit cu drept de deducere)',
  taxare_inversa_interna_livrare: 'Livrare cu taxare inversă internă (factură fără TVA)',
  factura_storno_vanzare: 'Factură de corecție emisă (storno în roșu)',
  factura_avans_client: 'Factură de avans emisă clientului',
  incasare_client: 'Încasare de la client (chitanță sau extras)',
  plata_furnizor: 'Plată către furnizor',
  depunere_numerar: 'Depunere de numerar la bancă (prin viramente interne)',
  comision_bancar: 'Comision bancar reținut de bancă',
  acordare_avans: 'Acordarea unui avans de trezorerie unui angajat',
  plata_taxe: 'Plata taxelor și impozitelor către buget',
  bon_consum: 'Bon de consum — ieșire de materiale din stoc',
  diferente_inventar: 'Diferențe constatate la inventariere (plus sau minus)',
  imputare_lipsa: 'Imputarea unei lipse la inventar către gestionar',
  stat_plata: 'Statul de plată — drepturile salariale ale lunii',
  plata_salarii: 'Plata salariilor nete',
  punere_in_functiune: 'Punerea în funcțiune a unui mijloc fix',
  amortizare: 'Amortizarea lunară a mijloacelor fixe',
  casare_mijloc_fix: 'Casarea unui mijloc fix (scoaterea din uz)',
  vanzare_mijloc_fix: 'Vânzarea unui mijloc fix (cedare cu titlu oneros)',
  leasing_intrare: 'Intrarea unui bun în leasing financiar',
  factura_leasing: 'Factura ratei de leasing (principal, dobândă, TVA)',
  plata_leasing: 'Plata ratei de leasing',
  cheltuiala_in_avans: 'Cheltuială în avans — înregistrarea inițială',
  recunoastere_cheltuiala_avans: 'Recunoașterea lunară a cheltuielii din avans',
  venit_in_avans: 'Venit în avans — înregistrarea inițială',
  client_incert: 'Client devenit incert sau în litigiu',
  provizion_constituire: 'Constituirea unui provizion pentru riscuri și cheltuieli',
  diferenta_curs_nefavorabila: 'Diferență nefavorabilă de curs valutar',
};

const den = (c) => { const n = coa.accountName(c); return n ? `${c} ${n}` : String(c); };

// Cele 40 de situatii, in ordinea in care apar in viata unei firme.
const ALESE = [
  ['Cumpărări', ['factura_cumparare_marfuri', 'factura_cumparare_materii', 'factura_servicii_primita', 'factura_utilitati', 'factura_imobilizare', 'achizitie_intracomunitara', 'import_vamal', 'taxare_inversa_interna_achizitie', 'combustibil_50', 'factura_storno_cumparare']],
  ['Vânzări', ['factura_vanzare_marfuri', 'factura_vanzare_servicii', 'factura_vanzare_produse', 'bon_fiscal_z', 'livrare_intracomunitara', 'export_extracomunitar', 'taxare_inversa_interna_livrare', 'factura_storno_vanzare', 'factura_avans_client']],
  ['Trezorerie', ['incasare_client', 'plata_furnizor', 'depunere_numerar', 'comision_bancar', 'acordare_avans', 'plata_taxe']],
  ['Stocuri și producție', ['bon_consum', 'diferente_inventar', 'imputare_lipsa']],
  ['Salarii', ['stat_plata', 'plata_salarii']],
  ['Imobilizări și leasing', ['punere_in_functiune', 'amortizare', 'casare_mijloc_fix', 'vanzare_mijloc_fix', 'leasing_intrare', 'factura_leasing', 'plata_leasing']],
  ['Regularizări', ['cheltuiala_in_avans', 'recunoastere_cheltuiala_avans', 'venit_in_avans', 'client_incert', 'provizion_constituire', 'diferenta_curs_nefavorabila']],
];

const blocuri = [
  { tip: 'p', text: 'Anexa aceasta e un vocabular de lucru: pentru fiecare situație care apare frecvent într-o firmă, articolul contabil complet — toate liniile, nu doar cea evidentă.' },
  { tip: 'p', text: 'Sumele sunt de probă, alese ca să fie rotunde, iar cota de TVA e cea în vigoare. Ce contează sunt conturile și, mai ales, numărul de linii: majoritatea erorilor din practică nu vin din alegerea greșită a unui cont, ci din uitarea unei linii — vezi capitolul 11.' },
  { tip: 'cheie', text: 'Citește fiecare monografie întâi la numărul de linii, apoi la conturi. O vânzare de marfă are trei linii, nu două; o cedare de mijloc fix are patru.' },
];

let nr = 0; const lipsa = [];
for (const [grup, ids] of ALESE) {
  blocuri.push({ tip: 'h', text: grup });
  for (const id of ids) {
    const t = TIPURI.find((x) => x.id === id);
    if (!t) { lipsa.push(id); continue; }
    let lines = [];
    try { lines = t.build(probe(t)) || []; } catch (e) { lipsa.push(id + ' (build: ' + e.message + ')'); continue; }
    lines = lines.filter((l) => l && l.debit && l.credit);
    if (!lines.length) { lipsa.push(id + ' (fara linii)'); continue; }
    nr += 1;
    blocuri.push({
      tip: 'tabel',
      titlu: `${nr}. ${TITLU[id] || t.nume}`,
      cap: ['Debit', 'Credit', 'Suma', 'Explicația'],
      randuri: lines.map((l) => [den(l.debit), den(l.credit),
        new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2 }).format(l.suma),
        String(l.explicatie || '')]),
      numerice: [3],
    });
  }
}

blocuri.push({ tip: 'h', text: 'Cum se citește o monografie' });
blocuri.push({ tip: 'p', text: 'Fiecare tabel e un singur articol contabil, cu toate liniile lui. Suma fiecărei linii apare o dată pe debit și o dată pe credit — de aceea articolul se închide întotdeauna, oricâte linii ar avea.' });
blocuri.push({ tip: 'p', text: 'Liniile marcate cu sume negative sunt stornări „în roșu”: aceleași conturi, sumă negată. Convenția și motivul ei sunt în capitolul 29.' });
blocuri.push({ tip: 'recap', titlu: 'Trei observații înainte de a folosi lista', puncte: [
  'Sumele sunt de probă. Conturile și numărul de linii sunt informația reală.',
  'O situație care nu se regăsește aici nu se rezolvă forțând cea mai apropiată: se compune un articol propriu, documentat.',
  'Cotele de TVA se schimbă; monografiile nu. Cota din tabele e cea în vigoare la data tipăririi.',
] });

fs.writeFileSync(path.join(__dirname, '../cuprins-carte-capB.json'),
  JSON.stringify({ parte: 'Anexe · de folosit, nu de citit', nr: 'B', titlu: `Monografii: ${nr} de situații frecvente`, blocuri }, null, 1), 'utf8');
console.log('  anexa B:', nr, 'monografii generate; lipsa/esec:', lipsa.length ? lipsa.join(', ') : 'niciuna');
