'use strict';

// Extensie idempotentă a fiecărui capitol cu o fișă de lucru specifică temei.
// Se rulează după adăugarea unui capitol nou; nu dublează fișele deja existente.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const fise = {
  1: ['separarea performanței de numerar și validarea ecuației poziției financiare', 'balanță, extrase, creanțe/datorii și puntea profit–numerar', 'recalculează profitul, poziția și variația de numerar din aceleași operațiuni', 'profit raportat fără creanță reală ori numerar fără sursă explicată'],
  2: ['completitudinea partidei duble și substanța fiecărei mișcări', 'document, articol contabil, jurnal și balanță', 'urmărește sursa și destinația pentru un eșantion și recalculează egalitatea', 'note echilibrate folosite pentru a masca un cont greșit'],
  3: ['clasificarea consecventă în planul de conturi și analitice utile', 'plan de conturi, politici, nomenclatoare și balanță analitică', 'testează maparea operațiunii–cont–raport și consistența între perioade', 'conturi diverse cu rulaj mare ori analitice create numai la închidere'],
  4: ['delimitarea responsabilității și existența aprobărilor reale', 'contracte, fișe de rol, delegări, semnături și jurnal de acces', 'confruntă rolul declarat cu operațiunile efectiv inițiate, aprobate și postate', 'aceeași persoană inițiază, aprobă, postează și reconciliază'],
  5: ['completitudinea și ordinea ciclului de închidere', 'calendar, dependențe, liste de control și statusuri', 'selectează un livrabil și reface toate etapele și aprobările prealabile', 'declarație depusă înaintea finalizării reconcilierilor-sursă'],
  6: ['încadrarea corectă în regimurile fiscale aplicabile perioadei', 'vector fiscal, cifră de afaceri, salariați, afiliați, notificări și recipise', 'recalculează fiecare condiție la data relevantă și verifică tranzițiile', 'regim păstrat din anul precedent fără retestarea eligibilității'],
  7: ['preluarea integrală și exactă a soldurilor de deschidere', 'balanță închisă anterior, fișe analitice, confirmări și proces-verbal de migrare', 'reconciliază sold cu sold, pe monedă, partener și scadență', 'diferențe parcate în analitice diverse pentru a închide totalul'],
  8: ['integritatea egalității debit–credit și a reportării rezultatului', 'balanțe înainte/după închidere și note de reportare', 'recalculează totalurile și urmărește rezultatul în capitaluri proprii', 'egalitate obținută prin note manuale fără document și explicație'],
  9: ['realitatea, completitudinea și autorizarea documentelor justificative', 'originale/controlate, contracte, recepții, aprobări și registru de intrare', 'testează operațiunea din document până la bun/serviciu și responsabil', 'document formal corect fără probă de livrare ori necesitate economică'],
  10: ['traducerea fidelă a documentului în articol contabil', 'document, politică, monografie, notă și jurnal', 'reexecută încadrarea, data, sumele, conturile și explicația', 'monografie aleasă după furnizor, nu după natura operațiunii'],
  11: ['acoperirea controlată a operațiunilor recurente și excepționale', 'catalog de operațiuni, monografii aprobate și jurnal de modificări', 'compară tipurile reale cu catalogul și testează cazurile-limită', 'tip generic folosit pentru operațiuni neobișnuite fără revizie'],
  12: ['separarea stadiilor și aprobarea înainte de impact contabil', 'workflow, drepturi, loguri și probe de aprobare', 'urmărește eșantionul din ciornă până la postare și blocare', 'postare automată fără criterii, excepții și jurnal de intervenție'],
  13: ['funcționarea controalelor preventive la intrarea documentului', 'rapoarte de excepții, configurări, teste și rezolvări', 'introdu cazuri corecte și eronate și verifică răspunsul controlului', 'alertă ignorată sistematic ori control dezactivat fără aprobare'],
  14: ['secvența, conținutul și transmiterea la termen a facturilor emise', 'decizie de numerotare, facturi, contracte, index e-Factura și mesaje', 'testează continuitatea seriei și termenul de 5 zile lucrătoare', 'goluri neexplicate, anulări șterse ori index lipsă'],
  15: ['existența și integritatea disponibilului din bancă și casierie', 'extrase complete, confirmări, registru de casă, monetar și documentele plăților', 'reconciliază fiecare cont, numără casa și investighează elementele în tranzit', 'conturi bancare omise, casă creditoare ori sold scriptic constant mare'],
  16: ['reconcilierea fiecărei mișcări cu o sursă independentă', 'extrase, registru de casă, fișe contabile și registru de diferențe', 'punctează rând cu rând și urmărește diferențele până la document și rezolvare', 'diferențe vechi, reconciliere copiată ori sursă modificată ca să coincidă'],
  17: ['respectarea plafoanelor și limitelor legale pentru numerar și plăți', 'registru de casă, parteneri, documente fragmentate și calculul limitelor', 'agregă operațiunile după regulile legale și testează fragmentarea/plățile în lanț', 'documente sau plăți divizate artificial pentru a rămâne sub plafon'],
  18: ['existența, cantitatea, costul și deprecierea stocurilor', 'recepții, fișe de magazie, inventar, mișcări și calcul de cost', 'testează fizic, reconciliază cantitativ-valoric și verifică valoarea realizabilă', 'stoc negativ, fără mișcare, diferențe fizice ori marjă imposibilă'],
  19: ['transformarea completă și corectă a costurilor în producție finită', 'rețete, bonuri de consum/predare, rapoarte, producție neterminată și calculații', 'reexecută fluxul cantitativ și alocarea costurilor pentru loturi selectate', 'randament imposibil, consum standard neactualizat ori producție fără predare'],
  20: ['existența faptică și evaluarea tuturor elementelor inventariate', 'decizie, comisii, liste, confirmări, proces-verbal și note de valorificare', 'observă/retestează selecții și urmărește diferențele până la aprobare și contabilizare', 'liste precompletate din contabilitate ori diferențe compensate fără analiză'],
  21: ['exactitatea statului și conformitatea obligațiilor salariale', 'contracte, pontaje, state, concedii, plăți și D112', 'recalculează brut–net și costul pentru salariați și luni cu risc', 'parametri globali modificați fără dată de valabilitate ori test'],
  22: ['aplicarea individuală a deducerilor și facilităților salariale', 'declarații salariat, persoane în întreținere, funcție de bază și calcul', 'verifică eligibilitatea lunar și reexecută deducerea personală', 'aceeași deducere copiată tuturor sau păstrată după schimbarea situației'],
  23: ['existența, clasificarea, durata și amortizarea activelor', 'facturi, recepții, punere în funcțiune, registru și referat tehnic', 'inspectează, recalculează și separă tratamentul contabil de cel fiscal', 'pragul fiscal folosit ca unic criteriu contabil de capitalizare'],
  24: ['clasificarea contractului de leasing și separarea componentelor sale', 'contract, grafic, proces-verbal, facturi, opțiuni și registrul activelor', 'citește substanța, reface principalul/dobânda și verifică activul, datoria și TVA', 'contract tratat după titlu ori rată înregistrată integral pe cheltuială'],
  25: ['recunoașterea veniturilor și cheltuielilor în perioada economică potrivită', 'contracte, facturi, recepții, abonamente și calcule de regularizare', 'testează facturi de primit/emis și cheltuieli/venituri în avans înainte/după închidere', 'data facturii folosită automat în locul perioadei prestației'],
  26: ['reevaluarea completă a elementelor monetare în valută', 'documente valutare, cursuri oficiale, extrase și fișe pe fiecare monedă', 'recalculează la data operațiunii, decontării și închiderii', 'analitic numai în lei, fără cantitate valutară ori diferențe forțate'],
  27: ['evaluarea recuperabilității creanțelor și a ajustărilor necesare', 'vechime, litigii, corespondență, încasări ulterioare și estimări', 'testează indiciile pe client și recalculează ajustarea contabilă/fiscală separat', 'procent standard aplicat fără analiză ori creanțe vechi neajustate'],
  28: ['recunoașterea în perioada economică potrivită', 'contracte, facturi, recepții, abonamente și calcul de alocare', 'testează cheltuieli/venituri în avans și facturi de primit/emis', 'data facturii folosită automat în locul perioadei prestației'],
  29: ['păstrarea urmei corecțiilor prin stornare controlată', 'document inițial, motiv, aprobare, storno și document corect', 'urmărește legătura bidirecțională și efectul în declarații', 'ștergeri, suprascrieri ori storno fără referință la original'],
  30: ['completitudinea și exactitatea jurnalelor obligatorii', 'jurnale, balanță, secvențe și parametri de extracție', 'reconciliază totalurile pe perioadă și investighează excluderile', 'raport regenerat ulterior cu reguli diferite și fără versiune'],
  31: ['concordanța dintre balanță, carte mare și analitice', 'balanță, fișe, jurnal și rapoarte-sursă', 'recalculează rulaje și solduri și verifică analitic egal sintetic', 'diferențe explicate ca rotunjiri fără analiză pe document'],
  32: ['independența și integritatea reconcilierilor', 'reconcilieri semnate, surse externe și registru de diferențe', 'reexecută elementele materiale și urmărește rezolvarea celor vechi', 'reconciliere care modifică sursa pentru a o face egală'],
  33: ['detectarea erorilor care nu rup egalitatea contabilă', 'analize de tendință, confirmări, documente și teste de clasificare', 'folosește proceduri pe aserțiuni, nu doar total debit egal credit', 'concluzie de corectitudine bazată exclusiv pe balanță închisă'],
  34: ['completitudinea și actualitatea scadențarului de creanțe și datorii', 'fișe parteneri, contracte, termene, confirmări și încasări/plăți ulterioare', 'reconciliază cu balanța și testează scadența, vechimea, litigiile și cash-flow-ul', 'scadențe implicite, solduri vechi fără acțiune ori compensări presupuse'],
  35: ['înregistrarea TVA numai cu drept și documentație suficiente', 'facturi, registru TVA, statut partener, destinație și perioadă', 'testează exigibilitatea, dreptul, cota și restricțiile', 'TVA dedus numai fiindcă apare distinct pe factură'],
  36: ['identificarea și aplicarea corectă a regimurilor speciale de TVA', 'opțiuni, registre ANAF, facturi, încasări/plăți și calcule pe regim', 'verifică eligibilitatea, intrarea/ieșirea, exigibilitatea și pragul perioadei', 'regim special păstrat după pierderea condițiilor ori aplicat retroactiv'],
  37: ['completitudinea calendarului de declarații și exactitatea fiecărui formular', 'vector fiscal, registre-sursă, formulare, validări și calendar', 'reconciliază obligația cu sursa și verifică versiunea, perioada și termenul', 'declarație generată dintr-o balanță provizorie ori formular depășit'],
  38: ['dovada depunerii valide și urmărirea mesajelor autorității', 'fișier semnat, index, recipisă, erori, retransmiteri și confirmări', 'urmărește fiecare depunere până la recipisa validă și reconciliază versiunea acceptată', 'fișier încărcat considerat depus fără recipisă ori cu erori nesoluționate'],
  39: ['respectarea dependențelor și completitudinea închiderii lunare', 'calendar, checklist, reconcilieri, declarații, aprobări și statusuri', 'selectează o lună și reface ordinea până la blocare, inclusiv excepțiile', 'declarații depuse înaintea finalizării documentelor și reconcilierilor'],
  40: ['derivarea obiectivă a stării fiecărui pas din date', 'reguli de status, rapoarte-sursă, excepții și jurnal de calcul', 'recalculează starea din probe și testează revenirea din gata în deschis', 'status bifat manual, deși datele-sursă arată elemente nerezolvate'],
  41: ['integritatea perioadei blocate și controlul redeschiderilor', 'drepturi, loguri, aprobări, motive și livrabile înainte/după', 'inspectează toate postările ulterioare și propagarea lor în declarații/rapoarte', 'perioadă redeschisă informal ori modificată după depunere fără rectificare'],
  42: ['închiderea corectă a veniturilor/cheltuielilor și reportarea rezultatului', 'balanțe înainte/după, note de închidere și calcul rezultat', 'reexecută închiderile și verifică sold zero în clasele 6/7', 'note manuale care mută cheltuieli pentru a obține rezultatul dorit'],
  43: ['puntea completă dintre rezultatul contabil și impozitul pe profit', 'registru fiscal, balanță, D101, pierderi și dosare de facilități', 'recalculează ajustările în ordinea legală și reconciliază declarația', 'procent de 16% aplicat direct profitului sau credit scăzut din bază'],
  44: ['legalitatea repartizării și a plății rezultatului', 'situații aprobate, hotărâri, rezerve, activ net, 457 și plăți', 'recalculează profitul distribuibil, restricțiile și impozitul', 'dividend plătit înaintea testelor ori împrumut restituit când este blocat'],
  45: ['prezentarea completă și analiza calității performanței', 'balanță mapată, cont de profit, note și comparații', 'reconciliază fiecare rând și separă elementele recurente/neobișnuite', 'profit îmbunătățit prin reclasificare ori eveniment nerepetabil'],
  46: ['existența, evaluarea și clasificarea poziției financiare', 'balanță, bilanț, scadențare și foi conducătoare', 'reconciliază rândurile și testează curent/necurent și compensările', 'activ egal pasiv folosit ca unic test de corectitudine'],
  47: ['completitudinea notelor și coerența lor cu cifrele și riscurile', 'checklist de prezentări, contracte, politici și foi suport', 'leagă fiecare notă de cerință, balanță și raționament', 'text copiat din anul precedent cu date și riscuri vechi'],
  48: ['concordanța transversală a întregului set de raportare', 'toate situațiile, balanța, fluxul și modificările capitalului', 'reexecută concordanțele și investighează orice diferență, inclusiv zero forțat', 'formulare ajustate manual fără corectarea balanței-sursă'],
  49: ['integritatea, accesibilitatea și păstrarea arhivei', 'nomenclator, index, politici de retenție, copii și teste de restaurare', 'selectează documente vechi și probează găsirea, citirea și urma', 'fișiere existente dar ilizibile, neindexate ori fără copie verificată'],
  50: ['trasabilitatea acțiunilor și segregarea accesului', 'loguri imuabile, utilizatori, roluri, aprobări și incidente', 'urmărește cine a creat, modificat, aprobat și exportat operațiunea', 'conturi comune, loguri editabile ori intervenții administrative neexplicate'],
  51: ['controlul automatizării și păstrarea raționamentului uman', 'reguli, versiuni, teste, excepții, confirmări și jurnal de model', 'testează cazuri-limită și verifică manual operațiunile cu risc', 'automatizare extinsă fără proprietar, praguri și monitorizarea erorilor'],
  52: ['clasificarea corectă a politicii, estimării și erorii', 'memorandum, politici, informații datate, materialitate și aprobări', 'reconstituie informația disponibilă și verifică efectul prospectiv/retroactiv', 'contul 1174 folosit fără test de eroare și semnificație'],
  53: ['completitudinea obligațiilor incerte și adecvarea continuității', 'juridic, provizioane, evenimente ulterioare, fluxuri și scenarii', 'testează criteriile, estimarea, actualizarea și sensibilitatea lichidității', 'provizion folosit pentru netezire ori continuitate bazată pe promisiuni'],
  54: ['substanța și legalitatea tranzacțiilor cu asociații/afiliații', 'hartă afiliați, contracte, confirmări, activ net și hotărâri', 'reconciliază pe natură și verifică restricțiile înaintea plății', 'retrageri fără temei, netări sau condiții care nu sunt de piață'],
  55: ['trasabilitatea concluziei profesionale până la fiecare rând raportat', 'index, matrice de risc, foi conducătoare, probe și puncte deschise', 'selectează un rând și reface balanța, procedura, excepțiile și aprobarea', 'bife fără procedură, sursă, autor, dată ori concluzie']
};

for (let nr = 1; nr <= 55; nr += 1) {
  const fisier = path.join(DIR, `cuprins-carte-cap${nr}.json`);
  if (!fs.existsSync(fisier)) throw new Error(`Lipsește ${fisier}`);
  const capitol = JSON.parse(fs.readFileSync(fisier, 'utf8'));
  const [obiectiv, probe, procedura, risc] = fise[nr];
  const bloc = {
    tip: 'tabel',
    titlu: 'Dosarul de lucru al expertului',
    cap: ['Obiectiv', 'Probe de păstrat', 'Procedură de revizie', 'Semnal de risc'],
    randuri: [[obiectiv, probe, procedura, risc]],
    nota: 'Concluzia se datează și se semnează de întocmitor; revizorul documentează observațiile și închiderea lor. Referințele trebuie să permită refacerea traseului până la balanță, document și livrabil.'
  };
  const existent = capitol.blocuri.findIndex((b) => b.tip === 'tabel' && b.titlu === 'Dosarul de lucru al expertului');
  if (existent === -1) {
    const recap = capitol.blocuri.findIndex((b) => b.tip === 'recap');
    capitol.blocuri.splice(recap === -1 ? capitol.blocuri.length : recap, 0, bloc);
  } else {
    capitol.blocuri[existent] = bloc;
  }
  fs.writeFileSync(fisier, `${JSON.stringify(capitol, null, 1)}\n`, { mode: 0o644 });
}

console.log('Fișa Dosarul de lucru al expertului este prezentă în capitolele 1–55.');
