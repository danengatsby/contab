'use strict';
// Mod simplu (necontabil) + Dictionarul contabil: ascunde intrarile tehnic-contabile din meniu
// (implicit pentru necontabili/testeri, preferinta per utilizator in browser) si glosarul de
// termeni pe intelesul tuturor (modal cu cautare). Extras din app.js (Etapa 6). Depinde doar de
// nucleu; nu apeleaza inapoi in app.js. initUiMode e apelat din init().
import { $, USER, toast, fiscalText } from './core.js';

// ── Mod simplu (necontabil) + Dicționar contabil pe înțelesul tuturor ──
const GLOSAR = [
  ['Articol contabil (partidă dublă)', 'Orice operațiune se scrie de două ori: un cont primește (debit), altul dă (credit), cu aceeași sumă. De aceea totalurile trebuie să fie mereu egale — e sistemul de auto-verificare al contabilității.'],
  ['Balanță de verificare', 'Tabelul de control al firmei: soldul fiecărui cont la o dată. Dacă totalul pe Debit = totalul pe Credit, contabilitatea „se închide" — nu s-a pierdut nimic pe drum.'],
  ['Registru-jurnal', 'Lista tuturor operațiunilor firmei, în ordine cronologică, numerotate. E „istoria completă" — documentul legal de bază al contabilității.'],
  ['Cartea mare / Fișă de cont', 'Aceleași operațiuni, dar grupate pe fiecare cont în parte: cât a intrat, cât a ieșit și ce sold a rămas. Fișa de cont e „extrasul de cont" al oricărui cont contabil.'],
  ['Cont contabil / Plan de conturi', 'Un „sertar" cu etichetă numerică în care se adună sume de același fel: 4111 = clienți, 401 = furnizori, 5121 = banca, 371 = mărfuri. Planul de conturi e lista tuturor sertarelor.'],
  ['Debit / Credit', 'Cele două coloane ale oricărui cont. Nu înseamnă „rău/bine" — sunt doar sensurile mișcării: la bani și stocuri debitul crește averea; la datorii creditul o crește.'],
  ['Creanțe', 'Bani pe care ai să-i primești: facturi emise și neîncasate încă de la clienți.'],
  ['Datorii', 'Bani pe care ai să-i dai: facturi primite și neplătite încă, taxe datorate, salarii de plată.'],
  ['Scadențar (aging)', 'Lista „cine îmi datorează / cui datorez", cu vechimea fiecărei sume (0-30, 31-60, 61-90, 90+ zile). Cu cât o creanță e mai veche, cu atât e mai greu de încasat.'],
  ['Sold / Solduri inițiale', 'Soldul = ce rămâne într-un cont după toate plusurile și minusurile. Soldurile inițiale sunt punctul de pornire — situația firmei în ziua în care ai adus-o în aplicație.'],
  ['Rulaj', 'Cât s-a MIȘCAT printr-un cont într-o perioadă — total intrări și total ieșiri — spre deosebire de sold, care e ce a RĂMAS. Un cont poate avea rulaj mare și sold zero: au intrat și au ieșit aceiași bani.'],
  ['Analitic (cont analitic)', 'Împărțirea unui cont în „sertare mai mici": contul 4111 „clienți" se desface pe fiecare client în parte. Sintetic = totalul; analitic = detaliul din spatele lui.'],
  ['Exercițiu financiar', 'Anul contabil al firmei — de regulă 1 ianuarie – 31 decembrie. La finalul lui se închid conturile și se întocmesc situațiile financiare. În aplicație scrie „Anul 2026" — e același lucru.'],
  ['Reconciliere (punctaj)', 'Potrivirea a două evidențe care ar trebui să spună același lucru: extrasul de la bancă cu încasările din aplicație, sau soldul unui furnizor cu ce zice el că îi datorezi. Diferența arată ce lipsește sau ce s-a înregistrat greșit.'],
  ['Plafon', 'O limită legală de la care regulile se schimbă: peste plafonul de scutire devii plătitor de TVA, peste plafonul de microîntreprindere treci la impozit pe profit, peste plafonul de numerar plata trebuie făcută prin bancă. Aplicația te avertizează când te apropii.'],
  ['TVA colectată', 'TVA-ul pe care l-ai adăugat pe facturile TALE către clienți. Nu e banul tău — îl strângi pentru stat.'],
  ['TVA deductibilă', 'TVA-ul plătit de tine pe facturile de la furnizori. Statul ți-l „dă înapoi" scăzându-l din ce ai colectat.'],
  ['Decont de TVA (D300)', 'Socoteala lunară/trimestrială cu statul: TVA colectată minus TVA deductibilă = TVA de plată (sau de recuperat).'],
  ['TVA la încasare', 'Regim special: TVA-ul devine datorat abia când factura e ÎNCASATĂ, nu când e emisă. Bun pentru firme mici cu clienți care plătesc greu.'],
  ['Taxare inversă', 'La anumite achiziții (ex. din UE), nu plătești TVA furnizorului — îl calculezi tu și îl declari simultan la colectat și la deductibil. Efect net zero, dar obligatoriu de raportat.'],
  ['Exigibilitate (TVA)', 'Momentul în care TVA-ul devine datorat statului. De regulă e data facturii; la „TVA la încasare" e data la care chiar ai luat banii. Contează fiindcă decide ÎN CE LUNĂ intră TVA-ul în decont.'],
  ['Pro-rata', 'Dacă firma are și venituri cu TVA, și venituri scutite, nu-ți poți deduce tot TVA-ul de la furnizori — doar proporția care revine activității cu TVA. Acea proporție se numește pro-rata și se calculează pe an.'],
  ['Regularizare', 'Corectarea la final de perioadă a unei sume estimate pe parcurs: se recalculează cu cifra reală și se înregistrează diferența. Apare mai ales la TVA (pro-rata definitivă) și la ajustări.'],
  ['D394 / D390', 'Declarații informative: D394 = cu cine ai făcut afaceri în România (facturi emise/primite); D390 = ce ai vândut/cumpărat din alte țări UE.'],
  ['D112', 'Declarația lunară pentru salarii: cine a lucrat, cât a câștigat și ce contribuții/impozit s-au reținut.'],
  ['D100 / Impozit micro', 'Declarația cu impozitul datorat statului. La microîntreprinderi: un procent mic (1%) din TOATE veniturile trimestrului, indiferent de cheltuieli.'],
  ['Cheltuială nedeductibilă', 'O cheltuială reală a firmei pe care legea NU o lasă să micșoreze profitul impozitat: amenzi, lipsuri de gestiune, cheltuieli fără document. O plătești, dar plătești și impozit pe ea.'],
  ['Impozit pe profit', 'Impozitul de {impozitProfit|16} pe profitul firmei, calculat nu pe profitul contabil, ci pe cel fiscal — adică după ce se adaugă cheltuielile nedeductibile și se scad veniturile neimpozabile.'],
  ['Dividend', 'Partea din profit pe care asociații o iau pentru ei. Se poate lua doar din profit, după aprobare, și se impozitează separat, cu {impozitDividende|16} reținut de firmă la plată.'],
  ['Repartizarea profitului', 'Decizia, la închiderea anului, despre ce se face cu profitul: o parte obligatoriu la rezerva legală, restul rămâne în firmă sau se dă ca dividende. Fără această decizie, profitul rămâne „nerepartizat".'],
  ['Capital social', 'Banii sau bunurile puse de asociați la înființarea firmei. Nu sunt venit și nu se cheltuiesc ca atare — sunt „miza" cu care firma pornește și apar ca datorie a firmei către asociați.'],
  ['SAF-T (D406)', 'Fișierul standard prin care ANAF primește „toată contabilitatea" în format electronic: conturi, facturi, plăți, stocuri. Se depune lunar sau trimestrial, automat din datele existente.'],
  ['e-Factura / SPV', 'Sistemul național de facturi electronice: facturile B2B se trimit obligatoriu în SPV (Spațiul Privat Virtual) ca XML, în cel mult 5 zile lucrătoare.'],
  ['Storno', '„Anulează cu minus": operațiunea greșită nu se șterge (ar dispărea din istorie), ci se scrie încă o dată cu semn invers, ca să se anuleze reciproc.'],
  ['Amortizare / Mijloc fix', 'Un utilaj sau echipament scump (mijloc fix) nu e cheltuială dintr-o dată: costul lui se împarte pe anii de folosință. Bucata lunară se numește amortizare.'],
  ['Provizion', 'Bani puși deoparte în contabilitate pentru o cheltuială probabilă, dar încă nesigură ca sumă sau ca dată: un proces în curs, o garanție acordată clienților. Recunoști efortul acum, nu când vine nota de plată.'],
  ['Ajustare pentru depreciere', 'Recunoașterea faptului că ceva valorează azi mai puțin decât scrie în acte: un client care probabil nu mai plătește, marfă rămasă nevândută. Nu se șterge valoarea, ci se pune „în paranteză", reversibil.'],
  ['Reevaluare', 'Aducerea valorii unui bun (de regulă o clădire sau un teren) la valoarea lui de piață de azi, pe baza unui raport de evaluare. Spre deosebire de ajustare, poate și să CREASCĂ valoarea din acte.'],
  ['CMP (cost mediu ponderat)', 'Prețul „mediu" al unui produs din stoc, recalculat la fiecare intrare. Când vinzi sau consumi, ieșirea se evaluează la acest preț mediu.'],
  ['NIR', 'Nota de intrare-recepție: documentul intern care confirmă că marfa de pe factura furnizorului chiar a intrat în depozit, cu cantitățile numărate.'],
  ['Bon de consum', 'Documentul intern cu care scoți materiale din depozit pentru folosință proprie (producție, consum) — nu pentru vânzare.'],
  ['Aviz de însoțire', 'Hârtia care însoțește marfa pe drum când factura nu e gata încă. Factura se emite ulterior, pe baza avizului.'],
  ['Gestiune', 'Un loc de depozitare urmărit separat (depozit, magazin, mașină). Stocul se ține pe fiecare gestiune, cu un gestionar răspunzător.'],
  ['Închidere de lună / de an', 'Ritualul de sfârșit de perioadă: se „strâng" conturile de TVA, veniturile și cheltuielile se mută în rezultat și se calculează impozitul. Aplicația face pașii automat.'],
  ['CAS / CASS / CAM', 'Contribuțiile din salarii: CAS {cas|25} (pensie) și CASS {cass|10} (sănătate) se rețin din salariul angajatului; CAM {cam|2.25} (asigurări de muncă) e plătită de firmă, peste salariu.'],
  ['Avantaje în natură', 'Beneficii date angajatului altfel decât în bani (mașina firmei folosită personal, chirie plătită de firmă). Se impozitează ca salariul, deși nu se plătesc cash.'],
  ['Avans de trezorerie / Decont', 'Bani dați unui angajat „în avans" pentru cheltuieli (deplasare, cumpărături firmă). La întoarcere face decontul: aduce bonurile și restul de bani.'],
  ['Filă carnet comercializare', 'Documentul cu care cumperi legal produse agricole de la producători persoane fizice (Legea 145/2014) — fără TVA și fără factură clasică.'],
  ['Chitanță', 'Dovada scrisă că ai primit bani în numerar. Pentru încasările prin bancă dovada e extrasul, nu chitanța.'],
];
function renderGlossary(q) {
  const box = $('#glossaryList'); if (!box) return;
  const s = (q || '').toLowerCase().trim();
  const items = GLOSAR.filter(([t, e]) => !s || (t + ' ' + e).toLowerCase().includes(s));
  box.innerHTML = items.length
    ? items.map(([t, e]) => `<div class="gloss-item"><b>${t}</b><p>${fiscalText(e)}</p></div>`).join('')
    : '<p class="muted" data-u="u188">Niciun termen găsit — încearcă alt cuvânt.</p>';
}
$('#glossaryBtn') && $('#glossaryBtn').addEventListener('click', () => { renderGlossary(''); $('#glossarySearch').value = ''; $('#glossaryModal').classList.remove('hidden'); $('#glossarySearch').focus(); });
$('#glossaryClose') && $('#glossaryClose').addEventListener('click', () => $('#glossaryModal').classList.add('hidden'));
$('#glossaryModal') && $('#glossaryModal').addEventListener('click', (e) => { if (e.target.id === 'glossaryModal') $('#glossaryModal').classList.add('hidden'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#glossaryModal')) $('#glossaryModal').classList.add('hidden'); });
$('#glossarySearch') && $('#glossarySearch').addEventListener('input', (e) => renderGlossary(e.target.value));

// Mod simplu: ascunde intrarile tehnic-contabile din meniu (marcate cu .adv). Implicit pentru
// utilizatorii „necontabil"; preferinta se tine per utilizator, in browser.
function uiModeKey() { return 'contabo-uimode-' + ((USER && USER.username) || ''); }
// Codul de cont din etichetele de <option>. In restul paginii un `<span class="adv">` ar fi de
// ajuns, dar <option> randeaza TEXT: nu accepta markup, deci `.adv` n-are pe ce sa se aplice.
// Deci textul se rescrie: „Banca lei (5121)" -> „Banca lei" in modul simplu. `value` NU se atinge
// (formularele si JS-ul citesc de acolo), iar originalul se pastreaza in data-full ca sa se poata
// reveni exact la comutarea inapoi pe expert.
function applyAccLabels(simplu) {
  document.querySelectorAll('select[data-acc-labels] option').forEach((o) => {
    if (!o.dataset.full) o.dataset.full = o.textContent;
    o.textContent = simplu ? o.dataset.full.replace(/\s*\(\d{3,4}\)\s*$/, '') : o.dataset.full;
  });
}
function applyUiMode(mode) {
  document.body.classList.toggle('simple-ui', mode === 'simplu');
  applyAccLabels(mode === 'simplu');
  const b = $('#uiModeBtn');
  if (b) {
    // Pictograma vine din `data-ic` (masca SVG din styles.css), nu din text: bara laterala
    // foloseste un singur set de pictograme desenate, iar un emoji lasat aici ar fi singurul
    // element din alt alfabet vizual.
    b.textContent = mode === 'simplu' ? 'Simplu' : 'Expert';
    b.dataset.ic = mode === 'simplu' ? 'simplu' : 'expert';
    // Galben in modul EXPERT: acolo sunt vizibile conturile, registrele si notele contabile,
    // deci merita un semnal ca nu esti in vederea simplificata. Acelasi galben ca la sectiunea
    // deschisa din meniu (#f0c14b), nu unul nou.
    b.classList.toggle('mod-expert', mode !== 'simplu');
    b.setAttribute('aria-label', mode === 'simplu'
      ? 'Mod simplu activ — apasă pentru modul expert (arată și partea tehnic-contabilă)'
      : 'Mod expert activ — apasă pentru modul simplu (ascunde partea tehnic-contabilă)');
  }
}
export function initUiMode() {
  let saved = null;
  try { saved = localStorage.getItem(uiModeKey()); } catch (e) { /* privat */ }
  // Implicit SIMPLU pentru cine nu e contabil: necontabili si testeri (inclusiv contul demo).
  // Contabilii si adminul pornesc in expert. Preferinta salvata a userului bate oricum implicitul.
  const simpluImplicit = USER && (USER.tip === 'necontabil' || USER.tip === 'tester') && USER.role !== 'admin';
  applyUiMode(saved || (simpluImplicit ? 'simplu' : 'expert'));
}
// Uneltele barei de sus, strânse pe telefon (vezi `#toolsBtn` în styles.css). Comutatorul e pur
// CSS pe `.topbar`: butoanele nu se mută din DOM, deci nu se pierde niciun ascultător și nu e
// nimic de refăcut la rotirea ecranului. Se închide la alegerea unei unelte — altfel panoul ar
// rămâne deschis peste pagina pe care tocmai ai cerut-o.
$('#toolsBtn') && $('#toolsBtn').addEventListener('click', () => {
  const bara = document.querySelector('.topbar');
  const deschis = bara.classList.toggle('tools-open');
  $('#toolsBtn').setAttribute('aria-expanded', String(deschis));
});
$('#sideTools') && $('#sideTools').addEventListener('click', (e) => {
  if (!e.target.closest('button')) return;
  document.querySelector('.topbar').classList.remove('tools-open');
  $('#toolsBtn').setAttribute('aria-expanded', 'false');
});

$('#uiModeBtn') && $('#uiModeBtn').addEventListener('click', () => {
  const mode = document.body.classList.contains('simple-ui') ? 'expert' : 'simplu';
  try { localStorage.setItem(uiModeKey(), mode); } catch (e) { /* privat */ }
  applyUiMode(mode);
  toast(mode === 'simplu'
    ? 'Mod simplu: partea tehnic-contabilă (balanță, registre, plan de conturi, închideri) e ascunsă din meniu. Contabilitatea rulează neschimbată în fundal — revii oricând cu 🛠.'
    : 'Mod expert: toate meniurile sunt vizibile.');
});
