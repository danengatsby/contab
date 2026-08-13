# Fluxul de lucru (cei 5 pași)

## Fluxul de lucru (cei 5 pași)

1. **Documente** — încarci un PDF. Aplicația extrage automat din text: CUI-uri, nr./dată
   document, bază impozabilă, TVA, cotă, total. Sensul (vânzare/cumpărare) este dedus
   comparând CUI-ul emitentului cu CUI-ul firmei tale (Setări).
2. **Confirmare** — verifici tipul documentului și valorile, apoi salvezi. Aplicația
   generează automat **articolul contabil** (`cont debitor = cont creditor`), cu
   previzualizare live.
3. **Registrul-jurnal** — toate articolele, cronologic, **numerotate secvențial** (Nr. crt. pe articol contabil, în UI/PDF/CSV); fiecare **notă contabilă** individuală (`/pdf/note/:id`) tipărește numărul ei din registrul-jurnal. Toate PDF-urile au „Pagina X / Y" în subsol.
4. **Cartea mare** — mișcările grupate pe fiecare cont, cu sold inițial/final.
5. **Balanța de verificare** — cu **cele patru egalități** (SI, rulaje, total sume, SF);
   te avertizează dacă nu „se închide”.

**Fiecare pas al ciclului contabil își poartă temeiul legal.** În cockpitul de închidere lunară și
în tabul „Închiderea anului", sub descrierea pasului apare un rând pliat „Temei legal:" cu actul și
articolul (Legea 82/1991, Codul fiscal, OMFP 1802/2014, OMFP 2634/2015, OMFP 2861/2009, Legea
31/1990, Legea 70/2015, OUG 120/2021, Codul de procedură fiscală) și, la deschidere, ce anume
prevede fiecare. Textul vine dintr-o **sursă unică** ([`src/temeiLegal.js`](../src/temeiLegal.js)),
nu scris în ecrane — altfel aceleași trimiteri ar ajunge să spună lucruri diferite despre același
pas. Trimiterile sunt reper de orientare, nu consultanță: legea se modifică, iar răspunderea pentru
aplicarea ei rămâne a contabilului (Legea 82/1991 art. 10-11).

**Închideri**: regularizarea lunară a TVA (4427 ↔ 4426 → 4423/4424) și închiderea
anuală a conturilor de venituri și cheltuieli în 121 „Profit și pierdere”.

**Flux de stare (ciornă → validat → aprobat → postat)**: un articol poate fi salvat ca **ciornă**
(`POST /api/entries {ciorna:true}`) — **vizibil în liste, dar exclus din contabilitate** (balanță,
registre, jurnale TVA, declarații, SAF-T). Se avansează pas cu pas cu `POST /api/entries/:id/status
{status}` prin `validat` → `aprobat` → `postat`. Doar la **postat** articolul intră în contabilitate
(`accounting.isPosted` = fără `status` sau `status==='postat'`; articolele vechi/create direct sunt
implicit postate — zero schimbare pe datele existente). Postarea verifică **perioada deschisă**.
Odată **postat**, starea nu se mai schimbă: corecția se face exclusiv prin **storno** (nu retrogradare).
O **ciornă** nu se stornează — se șterge direct.

**Corecții reversibile (storno)**: orice articol **postat** se poate **storna** — `POST /api/entries/:id/storno`
(opțional `{data}`, care trebuie într-o **perioadă deschisă**). Se generează o notă de reversare
(debit↔credit, aceleași sume), legată de original prin `stornoOf`, marcată `system`; originalul
primește `stornat`/`stornoBy` și devine **imutabil** (nu se mai șterge și nu se re-stornează). Ambele
note rămân în jurnal (append-only) — corecția e **documentată și reversibilă**, nu o ștergere care
pierde urma. Articolele cu impact pe **stoc** au corecția dedicată (mișcare/inventar), ca fișa de
magazie și cartea mare să nu diveargă.

**Ștergerea nu se aplică datelor postate**: un articol **postat** (inclusiv cele vechi, fără `status`)
**nu se șterge** prin API — `DELETE /api/entries/:id` întoarce 400 și trimite la storno. Doar **ciornele**
se șterg. O factură **ciornă** nu se emite ca e-Factura și nu apare în lista de trimis în SPV (se postează
întâi). Într-o perioadă **închisă** (`lockedUntil`) și înregistrarea, și postarea, și ștergerea ciornelor
sunt refuzate; corecția se face exclusiv prin storno într-o lună deschisă.

**Situații financiare**: contul de profit și pierdere și bilanțul (simplificat),
descărcabile în PDF.

Fiecare raport are buton **⬇ PDF**, iar fiecare înregistrare poate fi exportată ca
**notă contabilă** PDF.

**Export XML (declarații electronice):**
- **e-Factura UBL 2.1 (CIUS-RO)** — pentru fiecare factură emisă (link „e-Factura” în
  lista de înregistrări → `/xml/efactura/:id`). Folosește CUI-ul clientului și datele
  firmei din Setări (CUI, adresă, oraș, județ).
  **Perimetrul se derivă din tipul documentului** (steagul `eFactura` din `src/documentTypes/`),
  nu dintr-o listă separată: intră avansul încasat, facturarea avizului, vânzarea de mijloc fix,
  taxarea inversă internă (art. 331), reducerea comercială, factura în valută și cea în regim de
  TVA la încasare — pe lângă vânzările obișnuite. Rămân în afară documentele care *seamănă* cu o
  factură fără să fie: raportul Z, avizul de însoțire, factura simplificată (art. 319 alin. (12)),
  vânzarea cu amănuntul HoReCa, scontul de decontare și diferența de curs. Fiecare are răspunsul
  scris pe tip, cu motiv — două porți din suită refuză un tip de vânzare care nu răspunde.
  **Termenul de 5 zile** (restanțele din notificări) se aplică relației **interne**, B2B și **B2C**:
  o livrare intracomunitară e o factură validă, dar beneficiarul nu e stabilit în România, deci
  nu produce restanță — se poate totuși trimite manual în SPV.
- **e-Factura B2C** (facturi către persoane fizice, obligatorie din 1 ianuarie 2025) — identificatorul
  cumpărătorului (BT-47) poartă **CNP-ul** dacă persoana l-a dat, altfel codul convențional de
  **13 zerouri** (`0000000000000`); codul de TVA al cumpărătorului (BT-48) **nu** se completează.
  Relația se derivă din date: cod de TVA străin → în afara obligației; 13 cifre → CNP, deci B2C;
  lipsa codului pe o factură → tot B2C (persoana fizică nu e obligată să-și dea CNP-ul). Ce decide
  când codul nu spune nimic e **țara din fișa partenerului**. Bonurile fiscale nu intră: nu sunt
  facturi, deci nici nu trec de prima condiție.
- **D300** (decont TVA) și **D394** (informativă, agregare pe partener) — din tab-ul
  „TVA / D300” și din „Livrabile” (`/xml/d300?period=`, `/xml/d394?period=`). Jurnalele de TVA și
  recapitularea D300 au **defalcare pe cote** (21% / 11% / scutit-0%): bază + TVA pe fiecare cotă,
  pentru vânzări și cumpărări, în UI, în PDF-ul D300 și în **XML-ul D300** (rânduri `<rand rd=".."
  cota=".." baza=".." tva=".."/>` sub `livrari_taxabile`/`achizitii_taxabile`). Și **XML-ul D394** are
  defalcare pe cote: un `<rezumat_cote>` la nivel de declarație + noduri `<cota>` per partener.
- **D301** (decont special TVA) — pentru firma neplătitoare normal de TVA care înregistrează
  `achizitie_tva_speciala_d301` (`/xml/d301?period=`). Codul special art. 317 se configurează în
  profilul fiscal; TVA-ul este nedeductibil și intră în cost, cu obligația în 446. Operațiunile UE
  alimentează și D390 când firma are codul art. 317.
- **D307** (ajustări/corecții/regularizări TVA) — se înregistrează
  `ajustare_regularizare_tva_d307` (`/xml/d307?period=`), cu tipul A/L/C, operatorul și TVA-ul
  semnat. Validatorul electronic J1.1.0 acceptă și corecții negative sau rânduri zero în
  rectificative; aplicația le păstrează fără să le transforme în TVA curentă.
- **D107** (beneficiarii sponsorizărilor/mecenatului/burselor private) — firma plătitoare de
  impozit pe profit înregistrează `sponsorizare_mecenat_d107`, apoi descarcă raportul sau XML-ul
  anual (`/api/d107?year=`, `/xml/d107?year=`). Închiderea anuală păstrează reportul pe beneficiar,
  iar scăderea din impozit este alocată FIFO între sumele eligibile.
- **D311** (TVA colectată cu cod normal anulat) — se activează starea fiscală și data anulării în
  Setări, apoi se înregistrează `operatiune_tva_cod_anulat_d311` (`/xml/d311?period=`). Schema IV
  acoperă perioada codului anulat; schema V, operațiunile vechi declarate după reînregistrare.
- **D112** (contribuții sociale + impozit + evidență nominală) — din tab-ul „Salarizare”
  (`/xml/d112?period=`): creanțe fiscale agregate (CAS/CASS/impozit/CAM, total de plată) și
  câte un element `<asigurat>` per angajat cu bazele și contribuțiile, generat din statul de plată.
- **SAF-T — D406** (fișierul standard de audit fiscal, anual) — din tab-ul „10 · Situații
  financiare” (`/xml/saft?period=YYYY-MM` — **lunar/trimestrial**, regimul din 2025; `?year=` pentru anul întreg). Conține: `Header` (datele firmei, perioada, software),
  `MasterFiles` → `GeneralLedgerAccounts` (conturile cu solduri de deschidere/închidere
  pe an), `Customers`, `Suppliers`, `TaxTable` (cotele de TVA), `Products` (nomenclator),
  `Assets` (mijloace fixe), `PhysicalStock` (stoc final pe produs), `GeneralLedgerEntries`
  (toate articolele contabile ca tranzacții cu linii debit/credit, cu `TotalDebit=TotalCredit`),
  și `SourceDocuments` → `SalesInvoices` + `PurchaseInvoices` (facturile emise/primite cu
  linii detaliate — cantitate, preț, cont, TVA pe cotă — și `DocumentTotals` net/TVA/brut,
  legate de tranzacția din carte mare prin `TransactionID`). Liniile detaliate vin din
  `e.items` când există, altfel sunt derivate din articolul contabil. Tot în `SourceDocuments`,
  `Payments` conține încasările/plățile (`incasare_*`/`plata_*`) cu metoda de plată (Numerar/
  Virament dedusă din contul de trezorerie), linii debit/credit echilibrate și `DocumentTotals`;
  iar `MovementOfGoods` conține mișcările de stoc (recepții/ieșiri) cu cantități și unități de măsură.
  Generat de `src/saft.js`, pe standardul OECD SAF-T (v2.0) în implementarea românească
  **D406 / `Ro_SAFT_Schema` v2.4.9** (`AuditFileVersion` 2.4.9) — validat oficial (vezi mai jos).

> Notă: XML-urile D300/D394 folosesc rădăcina și namespace-ul ANAF și conțin cifrele
> corecte, dar trebuie **validate cu DUKIntegrator / XSD-ul ANAF curent** înainte de
> depunere; recipisa se obține de la ANAF/SPV. La fel, **SAF-T (D406)** acoperă cartea mare,
> nomenclatoarele și facturile (`SourceDocuments`); validarea oficială cere schema XSD D406
> condiționate de specificul firmei.
>
> **SAF-T (D406) — VALIDAT oficial.** Fișierul generat trece validatorul ANAF
> (**DUKIntegrator**) cu „Validare fără erori" în toate cele trei variante — lunară (L),
> de active (A) și de stocuri (C) — și, structural, XSD-ul oficial `Ro_SAFT_Schema` (v2.4.9,
> `AuditFileVersion` 2.4.9). Conține toate secțiunile cerute (inclusiv `UOMTable` pe coduri
> UN/ECE, `Owners`, `MovementTypeTable`, `Assets`, `PhysicalStock`) cu nomenclatoarele numerice
> ANAF (coduri de taxă 3001xx, tipuri de mișcare 10/20/40 etc.).
>
> Verificare oficială, la cerere: `scripts/valideaza-duk.sh D406 fișier.xml` (validatorul ANAF
> prin Docker). Detalii: `docs/guvernanta-fiscala.md`; dovada validării per versiune: `docs/validare-oficiala.md`. Validarea
> oficială se repetă oricum obligatoriu la depunerea în SPV.

**Gestiunea stocurilor (cantitativ-valoric, CMP, pe gestiuni):** tab-ul „Stocuri” ține un
nomenclator de **gestiuni** (depozite: cod, denumire, gestionar, cont) și de **produse** (cod,
denumire, UM, cont 371/301/345…, cod NC), plus mișcările de stoc: **recepții**, **ieșiri** și
**transferuri între gestiuni**. Stocul și **costul mediu ponderat (CMP)** se țin **separat per
(produs × gestiune)**, recalculate la fiecare intrare; transferul scoate din gestiunea sursă și
intră în destinație la CMP-ul sursei. Se poate filtra stocul pe gestiune. Fiecare mișcare și fiecare
inventar rețin **operatorul** (utilizatorul autentificat care a înregistrat), afișat în liste și pe
procesul-verbal — pistă de audit pe lângă jurnalul global.
Livrabile: **Situația stocurilor** (`/pdf/stocks`) și **Fișa de magazie** pe produs (registrul
cronologic cu CMP, `/pdf/stock-ledger/:id`). Datele alimentează secțiunile `Products`,
`PhysicalStock` (pe gestiune, cu `WarehouseID`) și `MovementOfGoods` (transferurile au și
`WarehouseIDTo`) din SAF-T. API: `GET/POST/DELETE /api/gestiuni`, `GET/POST/DELETE /api/products`,
`GET/POST/DELETE /api/stock-movements`, `GET /api/stocks[?gestiune=]`, `GET /api/stocks/:id/ledger`.

**Inventariere** (pe gestiune): din cardul „Inventariere” încarci lista cu **stocul scriptic**
(din evidență) pe fiecare produs, completezi **stocul faptic** (numărat fizic) și înregistrezi
diferențele — se generează automat atât mișcarea de stoc de reglare, cât și articolele contabile:
**plus de inventar `3xx = 758`**, **minus/lipsă `60x = 3xx`** la CMP, iar bifând „imputare” se adaugă
**`4282 = 7588 + 4427`** (recuperarea lipsei de la gestionar, cu TVA). Fiecare inventar se
**salvează ca document** și produce un **proces-verbal de inventariere** (PDF) cu scriptic/faptic/
diferențe/valori/imputări și totaluri, reimprimabil din lista „Inventarieri efectuate”. Livrabile:
**Lista de inventariere** (`/pdf/inventory`, formularul de numărat) și **Procesul-verbal**
(`/pdf/inventory-pv/:id`). Un inventar se poate **storna** (`POST /api/inventories/:id/storno`):
notele contabile sunt **reversate** (storno cu debit↔credit), mișcările de reglare sunt șterse
(stocul revine exact la starea de dinainte), documentul e marcat „stornat”, iar PV-ul tipărește
mențiunea STORNAT. API: `GET /api/inventory?gestiune=&asOf=`, `POST /api/inventory`,
`GET /api/inventories`, `POST /api/inventories/:id/storno`.

Pentru recepții se poate tipări **NIR-ul** (Nota de Intrare-Recepție și constatare de diferențe,
`/pdf/nir?id=` pentru o mișcare sau `?document=&gestiune=` pentru toate recepțiile aceluiași
document): furnizor, gestiune, dată, liniile cu cantitate/preț/valoare, total și rubrici de semnătură
(comisia de recepție, gestionar). Furnizorul se completează pe mișcarea de recepție. Simetric, pentru
ieșiri se tipărește **bonul de consum** (`/pdf/bon-consum?id=` sau `?document=&gestiune=`), cu liniile
valorate la **CMP** și rubrici de semnătură (predat/primit/aprobat). Pentru transferuri (marfa care
circulă fizic între gestiuni) se tipărește **avizul de însoțire a mărfii** (`/pdf/aviz?id=`), cu
expeditor/destinatar (gestiunile), valoare la CMP-ul sursei și rubrici expeditor/delegat/primire.

Documentele de stoc (NIR/bon de consum/aviz) primesc **serie și număr secvențial** (configurabile în
cardul „Serii documente”): numărul se atribuie automat la prima tipărire și **rămâne fix la
reimprimare** (stocat pe mișcare), conform regimului intern de numerotare. API: `GET/POST
/api/doc-series`. Toate documentele numerotate apar în **registrul documentelor emise**
(`/pdf/doc-register`, `GET /api/doc-register`) — listă de control cu tip, serie/nr, dată, gestiune,
referință, valoare și operator. Lista de mișcări se poate **filtra** (instant, în browser) după
**tip** (recepție/ieșire/transfer), **gestiune**, **lună** și o **căutare liberă** (produs / document /
operator).

Fiecare mișcare poate genera **automat articolul contabil** („postează nota”): recepția
**`3xx = 401`** (la valoarea de intrare), iar ieșirea (**descărcarea de gestiune**) **`60x = 3xx`**
la **valoarea CMP** calculată de gestiune (607 mărfuri, 601 materii prime, 602 materiale, 711 produse
finite…). Nota e legată de mișcare (`entryId`/`movementId`); ștergerea mișcării șterge și nota.
`POST /api/stock-movements/:id/post`.

**Mijloace fixe (registru + amortizare):** tab-ul „Mijloace fixe” ține registrul de imobilizări
(denumire, cont 21x/20x, cost, valoare reziduală, dată achiziție / punere în funcțiune, durată în
luni, furnizor). Amortizarea se calculează automat după **3 metode** — **liniară**, **degresivă** (AD, cu coeficient
1,5/2,0/2,5 după durată și trecere la liniar) și **accelerată** (50% în primul an, restul liniar) —
(începe din luna următoare punerii în funcțiune; contul de amortizare 281x/280x vine dintr-o **hartă
explicită** cont imobilizare → cont amortizare, nu din compunerea codului) și se poate
**înregistra lunar** în contabilitate cu un click (articolul `6811 = 281x`, o linie per mijloc fix,
fără dublură pe aceeași lună).

**Alegerea metodei nu e liberă** (art. 28 alin. (5) Cod fiscal), iar formularul cere lista permisă de
la server (`GET /api/assets/metode?cont=`), ca regula să nu existe în două exemplare: **construcțiile
— numai liniar**; echipamentele tehnologice, mașinile, uneltele, instalațiile de lucru, computerele și
echipamentele periferice — toate trei; **orice alt mijloc fix — liniar sau degresiv, fără accelerată**.
Un computer înregistrat pe 214 (lângă mobilier, care nu poate) se marchează **explicit** pe activ, ca
`vehiculM1` la plafonul auto — sinteticul nu le deosebește, iar o euristică pe denumire ar schimba
impozitul. Aceeași regulă se aplică și metodei *fiscale*, fiindcă art. 28 despre ea vorbește.

**Investițiile ulterioare (modernizări)** se înregistrează pe activ, nu ca active noi și nu ca
cheltuială a lunii: cheltuielile care **îmbunătățesc parametrii tehnici inițiali** majorează
valoarea mijlocului fix și se recuperează prin amortizare pe **durata rămasă**, începând cu luna
**următoare** finalizării (art. 28 alin. (3) Cod fiscal). Planul se recalculează singur — rata
lunară crește de la luna aceea încolo, iar planul închide exact pe valoarea majorată. Fără această
posibilitate contabilul avea două ieșiri, ambele greșite: un activ nou separat (registrul se umple
cu fantome, iar casarea reală nu le mai găsește) sau cheltuială directă (deducere luată prea
devreme, integral, în loc de eșalonat). Articolele contabile ale investiției se înregistrează
separat, cu tipurile existente `imobilizare_in_curs` + `punere_in_functiune`.
Două refuzuri deliberate: investiția a cărei **lună de efect e într-o perioadă închisă** e respinsă
(amortizarea acelei luni a fost deja postată pe planul vechi, iar recalcularea ar face registrul să
contrazică notele — defectul reparat cândva la casare); iar investiția la un activ **amortizat
integral** cere explicit `durataSuplimentaraLuni`, fiindcă nu mai există durată rămasă peste care să
se eșaloneze — o durată inventată ar fi o decizie fiscală luată de cod. API:
`POST /api/assets/:id/investitii`, `DELETE /api/assets/:id/investitii/:invId`.

**Ce nu se amortizeaza** e refuzat la înregistrare, cu motivul scris: terenurile (2111 — art. 28 alin.
(4); se amortizează doar amenajările, 2112), imobilizările în curs (231–235, cât timp nu sunt puse în
funcțiune — există tipul `punere_in_functiune`), imobilizările financiare (26x) și **conturile
rectificative** — amortizările (28x) și ajustările pentru depreciere (29x). Ultimele nu sunt active,
ci corecția lor: un mijloc fix înregistrat pe 2813 producea articolul `6811 = 281`, adică amortizarea
unei amortizări, și intra așa în registru și în secțiunea `Assets` din SAF-T. Regula e pe **familie**,
nu pe o listă de coduri, deci un cont 28x/29x adăugat mâine e exclus prin construcție. Sinteticul **211 e
respins ca ambiguu**: acoperă și terenul, și amenajarea. Mijloacele fixe înregistrate *înainte* de
aceste gărzi nu se corectează tăcut — o recalculare ar schimba retroactiv articole deja postate — ci
apar cu avertisment în registru (`neconformitati` pe fiecare rând).

Livrabile PDF: **Registrul mijloacelor fixe** (`/pdf/assets`) și
**Fișa mijlocului fix** cu planul complet de amortizare (`/pdf/asset/:id`). Datele alimentează
secțiunea `Assets` din SAF-T (D406). API: `GET/POST /api/assets`, `GET /api/assets/:id/schedule`,
`GET /api/assets/metode`, `POST /api/assets/:id/investitii`, `POST /api/assets/:id/scrap`, `DELETE /api/assets/:id`,
`POST /api/assets/depreciation?period=`.

**TVA la încasare** (regim special): grupul de documente „TVA la încasare” folosește contul
**4428 „TVA neexigibilă”** în loc de 4427/4426 pe factură; TVA devine exigibilă (intră în decontul
D300) abia la **încasarea** facturii emise (`4428 = 4427`) sau la **plata** facturii primite
(`4426 = 4428`). Tipuri: factură vânzare/cumpărare (TVA la încasare) + cele două operații de
exigibilitate. Decontul numără doar mișcările 4427/4426, deci neexigibila e exclusă corect până la
încasare/plată. În tab-ul „TVA / D300” există și o **exigibilitate automată**: introduci suma brută
încasată/plătită și cota, iar TVA-ul devenit exigibil se calculează (`brut × cotă / (100+cotă)`) și se
postează nota corespunzătoare (`POST /api/tva-incasare/exigibilitate`). Tot acolo se afișează
**registrul TVA neexigibilă** — cât TVA colectată/deductibilă (`4428`) este încă neexigibilă
(pe facturi neîncasate/neplătite), cu lista mișcărilor: `GET /api/tva-neexigibila`.

**Leasing financiar:** grupul de documente „Leasing” acoperă ciclul — intrarea imobilizării cu
datoria aferentă (`21x = 167`), factura de rată (`167` principal + `666` dobândă + `4426` TVA `= 404`)
și plata ratei (`404 = 5121`). Imobilizarea se adaugă în registrul de mijloace fixe pentru amortizare. Tab-ul „Mijloace fixe” are
și un **generator de grafic de rate** (anuități constante sau rate de capital egale): tabel lunar
principal/dobândă/sold rămas + PDF (`/api/leasing-schedule`, `/pdf/leasing-schedule`).

**Imobilizări în curs:** grupul de documente „Imobilizări” acumulează costurile în contul **231**
(achiziție `231 = 404` + TVA, sau producție proprie `231 = 722`) și le transferă la **punerea în
funcțiune** în contul de imobilizare (`21x = 231`), de unde intră în registrul de mijloace fixe.
Tot în grupul „Imobilizări” se înregistrează **reevaluarea**: plus de valoare (`21x = 105` rezerve din
reevaluare) și minus de valoare (`105 = 21x` din rezervă și/sau `655 = 21x` pe cheltuială).

**Provizioane pentru riscuri și cheltuieli:** grupul „Provizioane” — constituire (`6812 = 151`) și
reluare/anulare (`151 = 7812`). Tratate ca **nedeductibile fiscal** (art. 26) în registrul de evidență
fiscală, cu venitul din reluare neimpozabil simetric.

**Decontări cu asociații / intragrup:** grupul „Asociați / Grup” — împrumut de la asociat
(`5xx = 455`), restituire (`455 = 5xx`), dobândă datorată (`666 = 455`) și decontări între unitate și
subunități (`481`, creanță sau datorie).

**Dividende:** grupul „Dividende” — repartizarea profitului la dividende (`117`/`121 = 457`) cu
**reținerea automată a impozitului** pe dividende (`457 = 446`, cota din parametrii fiscali, 10%) și
plata netă (`457 = 5xx`).

**Subvenții:** grupul „Subvenții” — de exploatare (`445 = 741`), pentru investiții (`445 = 475` venit în
avans), încasarea lor (`5xx = 445`) și recunoașterea eșalonată a venitului din subvenția pentru
investiții (`475 = 7584`, de regulă proporțional cu amortizarea).

**Cheltuieli / venituri în avans (regularizări):** grupul „Regularizări” — înregistrarea sumelor
plătite/încasate în avans (`471 = 401/5xx`, `4111/5xx = 472`) și **recunoașterea eșalonată** lunară
a cotei-părți (`6xx = 471`, `472 = 7xx`), pentru costuri/venituri multianuale (asigurări, chirii etc.).

**Valută / diferențe de curs:** grupul de documente „Valută” permite factura în valută (valoarea în
lei = sumă × curs) și înregistrarea **diferențelor de curs** la decontare/reevaluare — favorabile
(`4111`/`401`/`512x` `= 765`) sau nefavorabile (`665 = …`), pe contul de creanță/datorie/trezorerie ales.

**Parteneri (nomenclator):** tab-ul „Parteneri” ține CUI + denumire + adresă (stradă,
oraș, județ). Partenerii se creează automat când introduci un CUI pe o factură; adresa
completată aici este folosită ca **adresa clientului în e-Factura** și apare în D394. Partenerii se pot
**importa în masă din CSV** (coloane `CUI;Denumire;Adresă;Oraș;Județ;Țară`, antet opțional) — round-trip
cu exportul (`POST /api/partners/import`). La fel se importă **produsele** (`Cod;Denumire;UM;Cont;
Grupă;CodNC`, `POST /api/products/import`) și **conturi personalizate** în planul de conturi
(`Cont;Denumire;Clasă;Tip`, `POST /api/accounts/import`) — conturile importate se rețin în
`customAccounts`, se reînregistrează la pornire și supraviețuiesc re-seed-ului.

**Linii detaliate pe factură:** la facturile de vânzare poți adăuga linii
(denumire, cantitate, UM, preț, cotă). Dacă există linii, baza și TVA se calculează din
ele, iar **e-Factura UBL** are câte o linie (`InvoiceLine`) și **subtotaluri de TVA pe cotă** —
suportă **cote multiple pe aceeași factură** (21% / 11% / 0% scutit), cu câte un `TaxSubtotal` per
cotă și `TaxTotal` = suma subtotalurilor (conform regulii UBL BR-CO-14).

**Trimitere în SPV (ANAF e-Factura), OAuth2:** în Setări → „Trimitere în SPV” completezi
mediul (test/prod), CIF, `client_id`, `client_secret` și `redirect_uri` (înregistrat în
SPV), apoi „Conectează” (autorizare cu certificat digital pe logincert.anaf.ro). După
conectare, fiecare factură emisă are butonul **„trimite SPV”** (upload UBL) și
**„SPV: <stare>”** (verificare `stareMesaj`). Tokenul se reîmprospătează automat.
`redirect_uri` trebuie să fie accesibil public (ex: `http://159.69.200.202:8080/api/anaf/callback`).

> Reziliență: fiecare apel către ANAF/SPV are timeout (`CONTAB_ANAF_TIMEOUT_MS`, implicit
> 30000), iar cererile idempotente (GET) se reîncearcă automat cu backoff la erori tranzitorii
> — rețea, timeout, 429, 5xx (`CONTAB_ANAF_RETRIES`, implicit 2). Upload-ul și schimbul de
> token-uri (POST) nu se reîncearcă niciodată, ca să nu se dubleze o încărcare al cărei
> răspuns s-a pierdut; reîncercările apar în log ca avertismente.

**Recipisă + acceptare:** după trimitere, „SPV: <stare>” interoghează `stareMesaj`; când
starea e `ok` factura e marcată **acceptată** și apare butonul **„recipisă”** care descarcă
arhiva ZIP (`descarcare`) și o atașează ca document.

**CreditNote pentru storno:** facturile de tip „storno emis (în roșu)” se exportă ca
**UBL CreditNote (cod 381)**, cu sume pozitive și `BillingReference` către factura inițială.

**Import facturi primite din SPV:** cardul „Facturi primite în SPV” (tab Documente) listează
mesajele primite (`listaMesajeFactura`); butonul **„importă”** descarcă ZIP-ul, extrage
XML-ul UBL, îl citește (furnizor, CUI, nr./dată, bază, TVA) și deschide formularul de
confirmare ca o **cumpărare** — apoi salvezi înregistrarea (cu documentul atașat).

**Descărcare automată recipise:** bifa „Descarcă automat recipisele” (Setări → SPV) pornește
un job la 15 min care verifică `stareMesaj` pentru facturile trimise și descarcă recipisa
când starea e `ok`. Butonul **„Verifică toate acum”** rulează manual (`/api/anaf/poll`).

**CreditNote și pentru storno de achiziție:** storno-ul de cumpărare se exportă tot ca
CreditNote 381, dar cu **părțile inversate** (furnizorul = partenerul, clientul = firma);
acesta nu se trimite în SPV (e document primit).

**Reconciliere parteneri:** tab-ul „Reconciliere” construiește fișa pe 4111 (clienți) și 401
(furnizori), agregă efectul fiecărei facturi/plăți și **potrivește automat** factura cu
plata/încasarea de aceeași sumă; afișează soldul deschis per partener și totalurile.

**Import extras bancar (CSV / MT940 / CAMT.053):** cardul „Import extras bancar” (tab Documente)
citește tranzacțiile (auto-detectare delimitator/coloane pentru CSV; tag-uri `:61:`/`:86:` pentru
MT940; `<Ntry>` cu `Amt`/`CdtDbtInd`/`BookgDt` pentru CAMT.053 — ISO 20022 XML, formatul SEPA modern,
parsat namespace-agnostic ca e-Factura UBL), **potrivește partenerul** după descriere (nume/CUI) și
propune încasări/plăți
(plus comisioane/dobânzi). Confirmi/editezi liniile și le imporți — alimentează automat
reconcilierea. Module: `src/bank.js`.

**Import CreditNote din SPV:** la importul unei facturi primite, dacă documentul UBL este un
`CreditNote`, este clasificat automat ca **storno de achiziție** (`factura_storno_cumparare`),
cu referința la factura inițială.

**Dashboard (KPI):** tab-ul „Dashboard” (pagina de start) arată: sold clienți/furnizori, TVA de
plată, disponibil bancă/casă, venituri/cheltuieli/rezultat pe an, plus top creanțe și datorii.
Endpoint `/api/dashboard`.

**Registrul depunerilor + portofoliu + notificări de termene** (`src/declarations.js`):
- **Registrul depunerilor** (card în „Declarații ANAF"): declarațiile **așteptate** pe luna
  selectată sunt derivate din profilul firmei (plătitor de TVA → D300/D394 + **D406 lunar**; are
  angajați → D112; lună de trimestru → D100; neplătitorii de TVA → **D406 trimestrial**;
  **D390 apare automat** în lunile cu operațiuni intracomunitare în jurnal — **bunuri sau
  servicii**, art. 325; **D301** apare când neplătitorul are operațiuni TVA speciale postate;
  **D307** apare numai în luna cu ajustări/corecții/regularizări postate;
  **D311** apare numai în luna în care există taxă exigibilă cu codul normal anulat;
  **D107** apare în decembrie pentru plătitorii de impozit pe profit care au sponsorizări ori
  report disponibil;
  Intrastat, în schimb, doar pe bunuri, fiindcă e statistică de mărfuri), cu
  **termen de depunere** (25 ale lunii următoare; D406 — ultima zi a lunii următoare). Descărcarea XML-ului marchează automat „**generată**";
  manual se marchează „**depusă**" (cu nr. recipisă), „**eroare**" sau „**scutită**". Stările nu se
  retrogradează la re-descărcare. API: `GET /api/declarations?period=` · `POST /api/declarations/set`.
- **Portofoliu** (tab dedicat, vizibil cu ≥2 firme): vedere agregată peste toate firmele
  utilizatorului — declarații așteptate/depuse/nedepuse/erori pe lună, **% conformitate**,
  **top firme cu atenționări** (restanțe + erori), tabel per firmă și activitate recentă (din
  jurnalul de audit). `GET /api/portfolio?period=`.
- **Notificări termene fiscale** (🔔 în bara de sus, cu badge): restanțele și termenele din
  următoarele 7 zile, pe toate firmele accesibile, scanând ultimele 3 luni. O declarație dispare
  când e marcată depusă/scutită. Include și **e-Facturile B2B netrimise în SPV** (termen legal
  5 zile lucrătoare de la emitere) — semnalate și pe dashboard, cu alertă acționabilă.
  `GET /api/notifications`.
- **Digest zilnic pe email** (~07:00): fiecare utilizator cu email setat primește restanțele și
  termenele apropiate de pe firmele lui — prin SMTP-ul din Setări sau, în lipsă, prin **Resend**
  (`RESEND_API_KEY` din `.env`). Opt-out per utilizator din Setări → „Contul meu".
  Declanșare manuală (admin): `POST /api/notifications/digest`.
- **Fișa Rol din SPV** (card în „Declarații ANAF"): solicită de la ANAF **fișa pe plătitor** prin
  serviciile web SPV (`SPVWS2/rest/cerere?tip=Fisa Rol`, documentate în ClientSPV-ul oficial ANAF);
  răspunsurile (PDF) se listează din mesajele SPV și se atașează ca documente ale firmei. Necesită
  conexiunea SPV (OAuth) din Setări. API: `POST /api/anaf/fisa-rol` · `GET /api/anaf/spv-mesaje` ·
  `POST /api/anaf/spv-descarca/:id`.
