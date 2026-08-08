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
  's13-document': 'Tabul **➕ Adaugă document primit**: zona de încărcare, apoi formularul deschis cu „✏️ Adaugă manual".',
  's14-preview-pdf': 'Vizualizatorul din aplicație, peste ecran: registrul documentelor lunii, ca PDF.',
  's15-previzualizare': 'Formularul de factură de cumpărare completat pe cameră, cu previzualizarea notei contabile (debit / credit / sumă) care se recalculează.',
  's16-controale': 'Carton cu cele opt controale, apoi lista documentelor primite cu verdictul fiecăruia.',
  's17-emite': 'Tabul **🧾 Emite factură**: cele trei alegeri în limbaj obișnuit, apoi formularul deschis.',
  's18-preview-efactura': 'Vizualizatorul: fișierul **e-Factura (XML UBL)** randat ca factură lizibilă — furnizor, client, linii, cote, total.',
  's19-bani': '**Încasări & plăți**: registrul lunii cu butoanele de înregistrare, apoi **Verifică extrasul bancar**.',
  's20-stocuri': 'Tabul **Ce am pe stoc**: stocul pe gestiuni și mișcările lunii.',
  's21-salarii': '**Statul de plată**: brut, contribuții, impozit, net, pe fiecare angajat.',
  's22-mijloace': '**Mijloace fixe** cu amortizarea lunară, apoi **Leasing** cu scadențarul.',
  's23-registre': '**Registrul-jurnal**, apoi **Balanța** cu verdictul celor patru egalități.',
  's24-preview-csv': 'Vizualizatorul: balanța ca **fișier CSV**, în text simplu, coloană cu coloană.',
  's25-inchidere': '**Închiderea lunii**: lista de pași cu starea fiecăruia, derivată din date.',
  's26-inchidere-an': '**Închiderea anului**: cei trei pași anuali.',
  's27-regfiscal': '**Registrul de evidență fiscală**: drumul de la rezultatul contabil la cel fiscal.',
  's28-tva': '**TVA de plată**: decontul perioadei, defalcarea pe cote, jurnalele.',
  's29-etva': 'Cardul „Decont precompletat e-TVA — reconciliere".',
  's30-declaratii': '**Declarații ANAF**: „📮 De depus — luna…" cu termene, stare și fișierul pe fiecare rând; catalogul complet, pliat, dedesubt.',
  's31-preview-xml': 'Vizualizatorul: **XML-ul D300**, aranjat pe rânduri, cu etichetele lui.',
  's32-saft': 'Tabul **SAF-T (D406)**: ce pleacă în fișier.',
  's33-rapoarte': '**Situații financiare** (bilanț, cont de profit și pierdere), apoi **Scadențarul** pe vechimi.',
  's34-arhiva': '**Arhivă documente**: dosarul lunii.',
  's35-setari': 'Setările, parcurse: Firma mea, Contul meu, Cine are acces, Date & copii de siguranță, Conexiuni.',
  's36-audit': '**Jurnal de audit**: cine a făcut ce și când.',
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
