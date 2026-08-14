// ─────────────────────────────────────────────────────────────────────────────
//  GENEREAZA capitolul „Scenariul, scena cu scena" din docs/scenariu-video-prezentare.md.
//
//  De ce exista: documentul spunea el insusi ca acel capitol „se genereaza … nu se scriu de mana,
//  altfel driftează la prima replica schimbata" — dar generatorul NU exista, iar capitolul era
//  scris de mana. Adica exact deriva impotriva careia se avertiza, cu avertismentul ca dovada ca
//  cineva stia. La rescrierea filmului (39 de scene, blocul nou despre angajarea contabilului)
//  documentul ar fi ramas pe scenariul vechi, contrazicand vocea din film.
//
//  Sursele, toate din depozit, deci reproductibil fara instanta de filmare:
//    scripts/naratiune-video.json   — id + textul ROSTIT (o singura sursa, si pentru voce)
//    scripts/naratiune-durate.json  — durata masurata a fiecarui WAV (din generarea vocii)
//    ECRANE, mai jos                — ce se VEDE; nu se poate deriva din text, si descrie
//                                     filmarea, deci sta langa ea, nu in naratiune
//
//  Rulare:  node scripts/genereaza-scenariu.js         (scrie documentul)
//           node scripts/genereaza-scenariu.js --check (doar verifica; iese 1 daca a driftat)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');

const RADACINA = path.join(__dirname, '..');
const DOC = path.join(RADACINA, 'docs', 'scenariu-video-prezentare.md');
const START = '<!-- SCENE:START — generat de scripts/genereaza-scenariu.js, nu edita manual -->';
const STOP = '<!-- SCENE:STOP -->';

/** Ce se VEDE in fiecare scena. Cheile trebuie sa acopere exact scenele din naratiune — daca una
 *  lipseste sau prisoseste, generatorul se opreste: o descriere ramasa in urma e mai rea decat una
 *  lipsa, fiindca pare actuala. */
const ECRANE = {
  's10d-migrare': 'Ecranul „Date & copii de siguranță", cardul de migrare: fișierul urcat, coloanele recunoscute și previzualizarea dinaintea scrierii.',
  's12c-simplu': 'Tabloul de bord, comutat în modul simplu și înapoi în expert — se vede cum dispar și reapar codurile de cont și intrările tehnice.',
  's29c-intrastat': 'Ecranul de declarații, cu Intrastat în listă; carton peste el: statistică la INS, prag pe fiecare sens.',
  's30c-situatie': 'Registrul declarațiilor, derulat; carton peste el cu cele patru declarații de situație: D301, D307, D311, D107.',
  's30d-corectie': 'Același registru; carton peste el: rectificativa înlocuiește, declarația de corecție atinge o singură sumă.',
  's36c-carte': 'Ghidul din aplicație, derulat; carton peste el: cartea despre contabilitate, pe același drum ca aplicația.',
  's37b-recuperare': 'Ecranul „Date & copii de siguranță", zona de backup; carton peste el: arhivă criptată, în afara serverului, cu refacerea probată.',
  's10b-plan': '**Plan de conturi**: planul oficial românesc, cu locul în care se adaugă analitice proprii.',
  's10c-solduri': 'Setări → Date: cardul **Solduri inițiale (preluare firmă cu istoric)**, cu importul balanței din programul vechi.',
  's16b-flux': '**Documente primite (listă)**: coloana de stare — ciornă, validat, aprobat, postat.',
  's20c-inventariere': 'Pagina de stocuri, jos: **lista de inventar**, cantitățile faptice, plusurile și minusurile.',
  's21c-regsalarii': '**Registru anual de salarii**: cumulul pe an, per angajat.',
  's22c-leasing': '**Leasing**: contractul și scadențarul ratelor, cu principal, dobândă și TVA.',
  's24a-regularizari': 'Carton „Faza 7 — regularizările", apoi tabul **Închiderea lunii**.',
  's24b-reevaluare': 'Închiderea lunii: zona de **reevaluare valutară** — candidații, cursul și diferența pe fiecare.',
  's24c-ajustari': '**Scadențar**: creanțele vechi și butonul de înregistrare a ajustării pentru depreciere.',
  's24d-storno': '**Articole stornate (corecții)**: fiecare storno legat de articolul original.',
  's24e-avans': 'Carton „cheltuieli și venituri în avans", apoi formularul de adăugare document cu grupul **Regularizări**.',
  's23c-balanta': '**Balanța**: sold inițial, rulaj, sold final, cu verdictul debit = credit.',
  's22d-scadentar': '**Scadențar clienți & furnizori**: soldul pe fiecare partener, pe vechimi.',
  's25b-blocare': 'Închiderea lunii, zona de blocare a perioadei, apoi cartonul despre forțare cu motiv scris.',
  's26b-repartizare': 'Închiderea anului, pasul de **repartizare a rezultatului**.',
  's26c-situatii': '**Situații financiare**: contul de profit și pierdere și bilanțul, cu anul precedent alături.',
  's26d-anexe': '**Anexe la situații**: fluxuri de trezorerie, modificările capitalurilor proprii, note explicative.',
  's31b-validare': 'Carton pe ecran plin: fiecare declarație trece validatoarele oficiale ANAF.',
  's01-prezentare': 'Pagina publică `prezentare.html`: antetul, cele trei cifre, „Nu trebuie să știi formula contabilă".',
  's02-preturi': 'Secțiunea de prețuri de pe aceeași pagină (Probă / Start / Pro), apoi „Ce face aplicația — și ce rămâne la tine".',
  's03-cont': 'Ecranul de autentificare → „🚀 Testează gratuit" → formularul de înscriere, cu **alegerea rolului** apăsată pe cameră: întâi „contabil", apoi „patron".',
  's04-doua-roluri': 'Carton pe ecran plin: „Patronul aduce. Contabilul răspunde."',
  's05-lista-contabili': 'Contul **patronului** → Setări → 👥 Cine are acces → cardul „🧮 Contabili și cereri de servicii", cu Maria Ionescu în listă: oraș, telefon, specializare.',
  's06-angajare': 'Selectorul de firmă din rândul contabilei (patronul alege PENTRU CARE firmă îl vrea), apoi tabelul „Cereri trimise de tine": una acceptată, una în așteptare, cu butonul „Retrage".',
  's07-acceptare': 'Contul **contabilei** → aceeași pagină, secțiunea „Cereri primite de la patroni" → clic pe **Accept**, pe cameră.',
  's08-multi-firma': 'Selectorul de firme al contabilei, deschis: firme de la **doi patroni diferiți**, plus a doua firmă a primului patron, tocmai acceptată.',
  's09-portofoliu': 'Tabul 🗂 **Portofoliu** — tabelul de conformitate: o linie pe firmă, o coloană pe lună.',
  's10-primaintrare': 'Înapoi pe contul patronului, luna de lucru pe iunie 2026. Grupurile din meniu deschise pe rând: Documente, Bani, Taxe, Rapoarte.',
  's11-ghid': 'Tabul **Ghid**, derulat, apoi **❓ Dicționar** deschis peste el.',
  's12-acasa': '**Acasă**: „⏰ De făcut acum" cu restanțele și termenele, apoi „Situația firmei — pe scurt".',
  's12b-birou': 'Chrome-ul de birou, arătat pe rând: bara de meniu de sus, banda de unelte, arborele de module din stânga, bara de stare de jos.',
  's13-document': 'Tabul **➕ Adaugă document primit**: zona de încărcare, apoi formularul deschis cu „✏️ Adaugă manual".',
  's14-preview-pdf': 'Vizualizatorul din aplicație, peste ecran: registrul documentelor lunii, ca PDF.',
  's15-previzualizare': 'Formularul de factură de cumpărare completat pe cameră, cu previzualizarea notei contabile (debit / credit / sumă) care se recalculează.',
  's16-controale': 'Carton cu cele opt controale, apoi lista documentelor primite cu verdictul fiecăruia.',
  's17-emite': 'Tabul **🧾 Emite factură**: cele trei alegeri în limbaj obișnuit, apoi formularul deschis.',
  's18-preview-efactura': 'Vizualizatorul: fișierul **e-Factura (XML UBL)** randat ca factură lizibilă — furnizor, client, linii, cote, total.',
  's19-bani': '**Încasări & plăți**: registrul lunii cu butoanele de înregistrare, apoi **Verifică extrasul bancar**.',
  's19b-reconciliere': '**Verifică extrasul bancar**: rândurile potrivite automat, cele rămase nepotrivite și soldul extras ↔ contabilitate.',
  's20-stocuri': 'Tabul **Ce am pe stoc**: stocul pe gestiuni și mișcările lunii.',
  's20b-productie': 'Tabul **Producție**: rețeta unui produs și o producție înregistrată — materialele ies, produsul finit intră.',
  's21-salarii': '**Statul de plată**: brut, contribuții, impozit, net, pe fiecare angajat.',
  's21b-angajati': 'Tabul **Angajați**: fișa unui angajat — contract, salariu de bază, deducere, persoane în întreținere.',
  's22-mijloace': '**Mijloace fixe**: fișa unui mijloc fix și amortizarea lunară calculată automat.',
  's22b-parteneri': '**Clienți & furnizori**: completarea după CUI (denumire, adresă, plătitor de TVA de la ANAF) și soldul fiecărui partener.',
  's23-registre': '**Registrul-jurnal**: toate operațiunile în ordine cronologică, cu documentul fiecăreia.',
  's23b-carte': '**Cartea mare**: fișa unui cont — sold inițial, mișcările în ordine cu documentul lor, sold final.',
  's24-preview-csv': 'Vizualizatorul: balanța ca **fișier CSV**, în text simplu, coloană cu coloană.',
  's25-inchidere': '**Închiderea lunii**: lista de pași cu starea fiecăruia, derivată din date.',
  's26-inchidere-an': '**Închiderea anului**: cei trei pași anuali.',
  's27-regfiscal': '**Registrul de evidență fiscală**: drumul de la rezultatul contabil la cel fiscal.',
  's28-tva': '**TVA de plată**: decontul perioadei, defalcarea pe cote, jurnalele.',
  's29-etva': 'Cardul „Decont precompletat e-TVA — reconciliere".',
  's29b-etransport': '**e-Transport**: formularul ghidat al unui transport și codul UIT primit, salvat pe transport.',
  's30-declaratii': '**Declarații ANAF**: „📮 De depus — luna…" cu termene, stare și fișierul pe fiecare rând; catalogul complet, pliat, dedesubt.',
  's30b-spv': 'Tabul **Mesaje și documente din SPV**: conectarea cu certificatul firmei, indexul de încărcare și recipisele.',
  's31-preview-xml': 'Vizualizatorul: **XML-ul D300**, aranjat pe rânduri, cu etichetele lui.',
  's32-saft': 'Tabul **SAF-T (D406)**: ce pleacă în fișier.',
  's33-rapoarte': 'Rapoartele de conducere: încasări pe perioade, cheltuieli pe categorii, previziunea de numerar.',
  's33b-buget': '**Buget vs realizat**, lună de lună, apoi **Scadențarul** clienți/furnizori pe vechimi.',
  's34-arhiva': '**Arhivă documente**: dosarul lunii.',
  's35-setari': 'Setările, parcurse: Firma mea, Contul meu, Cine are acces, Date & copii de siguranță, Conexiuni.',
  's36-audit': '**Jurnal de audit**: cine a făcut ce și când.',
  's36b-cautare': 'Paleta de căutare (Ctrl+K) cu un rezultat ales, **Dicționarul** deschis peste ea, apoi comutarea pe modul simplu.',
  's37-incredere': 'Pagina de backup, apoi cartonul „Validat cu validatorul publicat de ANAF".',
  's38-limite': 'Carton pe ecran plin: ce rămâne la patron și la contabil.',
  's39-final': 'Carton final: „30 de zile gratuit, fără card · contabo.space".',
};

function mmss(s) { return Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0'); }

function genereaza() {
  const scene = JSON.parse(fs.readFileSync(path.join(__dirname, 'naratiune-video.json'), 'utf8'));
  const durate = Object.fromEntries(
    JSON.parse(fs.readFileSync(path.join(__dirname, 'naratiune-durate.json'), 'utf8')).map((d) => [d.id, d.durata]));

  const lipsa = scene.filter((s) => !ECRANE[s.id]).map((s) => s.id);
  const inPlus = Object.keys(ECRANE).filter((k) => !scene.some((s) => s.id === k));
  if (lipsa.length) throw new Error('Scene fara descriere de ecran: ' + lipsa.join(', '));
  if (inPlus.length) throw new Error('Descrieri de ecran pentru scene inexistente: ' + inPlus.join(', '));
  const faraDurata = scene.filter((s) => !durate[s.id]).map((s) => s.id);
  if (faraDurata.length) throw new Error('Scene fara durata masurata: ' + faraDurata.join(', '));

  const total = scene.reduce((t, s) => t + durate[s.id], 0);
  let t = 1;
  const randuri = scene.map((s, i) => {
    const cand = mmss(t);
    t += durate[s.id];
    return `### ${String(i + 1).padStart(2, '0')} · \`${s.id}\` — ${cand} · voce ${Math.round(durate[s.id])} s\n\n`
      + `**Se vede:** ${ECRANE[s.id]}\n\n> ${s.text}\n`;
  });

  return `${START}\n\n**${scene.length} de scene**, în ordinea ciclului contabil — cu blocul de deschidere despre\n`
    + `**angajarea contabilului**, fiindcă de acolo începe orice firmă. Fiecare scenă ține **exact cât vocea ei**:\n`
    + `acțiunile se execută, apoi filmarea așteaptă restul — de aceea imaginea nu fuge înaintea textului.\n\n`
    + `Durata totală a vocii: **${mmss(total)}**.\n\n`
    + randuri.join('\n') + `\n${STOP}`;
}

const doc = fs.readFileSync(DOC, 'utf8');
const i = doc.indexOf(START); const j = doc.indexOf(STOP);
if (i < 0 || j < 0) {
  console.error('Lipsesc marcajele SCENE:START / SCENE:STOP din ' + DOC + ' — pune-le in jurul capitolului 3.');
  process.exit(2);
}
const nou = doc.slice(0, i) + genereaza() + doc.slice(j + STOP.length);
if (process.argv.includes('--check')) {
  if (nou === doc) { console.log('Scenariul e la zi.'); process.exit(0); }
  console.error('Scenariul a DRIFTAT fata de naratiune — ruleaza `node scripts/genereaza-scenariu.js`.');
  process.exit(1);
}
fs.writeFileSync(DOC, nou);
console.log('Scenariul regenerat: ' + JSON.parse(fs.readFileSync(path.join(__dirname, 'naratiune-video.json'), 'utf8')).length + ' scene.');
