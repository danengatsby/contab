# Contab — aplicație de contabilitate (ciclul contabil)

Aplicație web care **primește documente primare în PDF** (facturi, chitanțe, NIR-uri,
state de plată…) și **livrează documente în PDF** (registrul-jurnal, cartea mare,
balanța de verificare, contul de profit și pierdere, bilanțul, note contabile),
urmând ciclul contabil românesc:

```
document justificativ → articol contabil → registrul-jurnal → cartea mare
   → balanța de verificare → declarații + situații financiare
```

Totul se bazează pe **partida dublă** (orice operațiune: un cont se debitează, altul se
creditează, cu aceeași sumă) și pe **planul de conturi românesc** (clasele 1–8).

## Rulare

```bash
npm install
npm start            # porneste pe http://localhost:3000  (sau PORT=3787 npm start)
npm test             # ruleaza suita de teste (44 verificari pe numerele cheie)
```

Apoi deschide `http://localhost:8080` în browser.

Navigarea e organizată pe categorii (meniuri în bara de sus): **Dashboard**, **Operațional**
(documente, bancă/casă, reconciliere, stocuri, mijloace fixe, salarizare), **Registre** (jurnal,
carte mare, balanță, analitic/scadențar), **Declarații & situații** (TVA/D300/D394, închideri,
situații financiare, livrabile), **Nomenclatoare** (parteneri, plan de conturi, ghid) și **Setări**.

**Teste automate** (`test/run.js`, `npm test`): rulează verificarea sintaxei tuturor fișierelor
(`npm run lint`) + **193 de verificări** pe datele exemplului din ghid construite pur (fără a atinge
`data/db.json`, prin `seed.scopedSeed()`) — balanța (echilibrată, SF 84.327,50), TVA de plată 840,
rezultat brut 687,50, registrul-jurnal (7 articole numerotate), amortizarea (liniară/degresivă),
stocurile (CMP, pe gestiuni), aging-ul FIFO, registrul fiscal, **e-Factura UBL** (total 16.940, TVA
2.940, bine-format), **D300/D394** (bine-format), **închiderea TVA** (de plată 840) și **anuală**
(rezultat 687,50), **reconcilierea** factură-plată, **bilanțul** (echilibrat, activ=pasiv 70.815),
**payroll** (net 2.925, CAS/CASS/impozit/CAM), **notele explicative** (7 note), și că SAF-T-ul e
bine-format cu toate secțiunile. Blochează regresiile.

- **Hook pre-pornire:** scriptul `prestart` rulează `npm test` înainte de `npm start` (pornirea
  locală e blocată dacă testele pică). Sub **pm2** (`node server.js` direct) hook-ul e ocolit — pentru
  a gata și acolo, rulează `npm test && pm2 restart contab`.
- **CI:** `.github/workflows/ci.yml` rulează `npm ci` + `npm run lint` + testele pe Node 18 și 20 la
  fiecare push/PR.

**Dashboard cu grafice** (SVG, fără dependențe): evoluția lunară venituri/cheltuieli/profit (bare
grupate), comparația creanțe vs datorii și structura aging pe intervale de vechime. `/api/dashboard-charts`.

### Acces din rețea / lansare pe IP public

Serverul ascultă implicit pe `0.0.0.0` (toate interfețele), deci este accesibil
și pe IP-ul public al mașinii. Pe acest server:

```bash
PORT=8080 HOST=0.0.0.0 node server.js
# → http://161.97.152.82:8080
```

Pentru ca accesul din exterior să funcționeze, portul trebuie deschis în
firewall (provider VPS + `ufw` dacă e activ), de ex.:

```bash
sudo ufw allow 8080/tcp
```

**URL curat pe portul 80 (recomandat, necesită root):** pe această mașină rulează
deja `nginx` pe portul 80. Adaugă un reverse proxy către aplicație:

```nginx
# /etc/nginx/sites-available/contab  (apoi: ln -s ... sites-enabled && nginx -t && systemctl reload nginx)
server {
    listen 80;
    server_name 161.97.152.82;   # sau domeniul tău
    client_max_body_size 25m;     # pentru upload de PDF-uri
    location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; }
}
```

**Pornire automată (recomandat, necesită root):** rulează ca serviciu systemd
ca să repornească la boot și să nu depindă de o sesiune:

```ini
# /etc/systemd/system/contab.service
[Unit]
Description=Contab
After=network.target
[Service]
WorkingDirectory=/var/www/contab
Environment=PORT=8080 HOST=0.0.0.0
# Environment=ANTHROPIC_API_KEY=sk-ant-...   # optional, pentru extragerea cu AI
ExecStart=/usr/bin/node server.js
Restart=always
User=dan
[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now contab
```

### Extragere cu AI (opțional, recomandat pentru facturi variate / scanate)

Aplicația poate citi **PDF-uri și imagini (JPG/PNG/WEBP — facturi scanate sau fotografiate)** cu
**Claude API** (`@anthropic-ai/sdk`, model `claude-opus-4-8`, intrare document PDF sau imagine +
ieșire structurată JSON). Tipul fișierului e detectat automat din conținut (PDF → bloc `document`,
imagine → bloc `image`). Pornește serverul cu cheia setată:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Când cheia este prezentă, fiecare upload este trimis la Claude pentru a extrage
câmpurile (CUI, nr./dată, bază, TVA, cotă, total) și a propune tipul de
înregistrare; **dacă apelul eșuează, se revine automat la regulile locale**.
Fiecare utilizator are un **plafon zilnic de extrageri AI** (`CONTAB_AI_DAILY_LIMIT`,
implicit 200/zi; contul public „demo": `CONTAB_AI_DAILY_LIMIT_DEMO`, implicit 10/zi) —
peste plafon se folosesc regulile locale, cu avertisment în formular.
Avantajul față de regulile locale: citește facturi în orice format, inclusiv
**PDF-uri scanate** (prin viziune). Poți activa/dezactiva din Setări. Modelul se
poate schimba cu `CONTAB_AI_MODEL=...`.

Pentru a încărca exemplul integrat din ghid (luna iunie, S.C. EXEMPLU PROD S.R.L.):

```bash
npm run seed         # din linia de comanda
# sau din interfata: Setări → „Încarcă exemplul din ghid”
```

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

**Închideri**: regularizarea lunară a TVA (4427 ↔ 4426 → 4423/4424) și închiderea
anuală a conturilor de venituri și cheltuieli în 121 „Profit și pierdere”.

**Situații financiare**: contul de profit și pierdere și bilanțul (simplificat),
descărcabile în PDF.

Fiecare raport are buton **⬇ PDF**, iar fiecare înregistrare poate fi exportată ca
**notă contabilă** PDF.

**Export XML (declarații electronice):**
- **e-Factura UBL 2.1 (CIUS-RO)** — pentru fiecare factură emisă (link „e-Factura” în
  lista de înregistrări → `/xml/efactura/:id`). Folosește CUI-ul clientului și datele
  firmei din Setări (CUI, adresă, oraș, județ).
- **D300** (decont TVA) și **D394** (informativă, agregare pe partener) — din tab-ul
  „TVA / D300” și din „Livrabile” (`/xml/d300?period=`, `/xml/d394?period=`). Jurnalele de TVA și
  recapitularea D300 au **defalcare pe cote** (21% / 11% / scutit-0%): bază + TVA pe fiecare cotă,
  pentru vânzări și cumpărări, în UI, în PDF-ul D300 și în **XML-ul D300** (rânduri `<rand rd=".."
  cota=".." baza=".." tva=".."/>` sub `livrari_taxabile`/`achizitii_taxabile`). Și **XML-ul D394** are
  defalcare pe cote: un `<rezumat_cote>` la nivel de declarație + noduri `<cota>` per partener.
- **D112** (contribuții sociale + impozit + evidență nominală) — din tab-ul „Salarizare”
  (`/xml/d112?period=`): creanțe fiscale agregate (CAS/CASS/impozit/CAM, total de plată) și
  câte un element `<asigurat>` per angajat cu bazele și contribuțiile, generat din statul de plată.
- **SAF-T — D406** (fișierul standard de audit fiscal, anual) — din tab-ul „10 · Situații
  financiare” (`/xml/saft?year=`). Conține: `Header` (datele firmei, perioada, software),
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
  Generat de `src/saft.js`, aliniat la structura OECD SAF-T 2.0 adaptată RO.

> Notă: XML-urile D300/D394 folosesc rădăcina și namespace-ul ANAF și conțin cifrele
> corecte, dar trebuie **validate cu DUKIntegrator / XSD-ul ANAF curent** înainte de
> depunere; recipisa se obține de la ANAF/SPV. La fel, **SAF-T (D406)** acoperă cartea mare,
> nomenclatoarele și facturile (`SourceDocuments`); validarea oficială cere schema XSD D406
> condiționate de specificul firmei.

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
(începe din luna următoare punerii în funcțiune; contul de amortizare 281x/280x e dedus din contul
de imobilizare) și se poate
**înregistra lunar** în contabilitate cu un click (articolul `6811 = 281x`, o linie per mijloc fix,
fără dublură pe aceeași lună). Livrabile PDF: **Registrul mijloacelor fixe** (`/pdf/assets`) și
**Fișa mijlocului fix** cu planul complet de amortizare (`/pdf/asset/:id`). Datele alimentează
secțiunea `Assets` din SAF-T (D406). API: `GET/POST /api/assets`, `GET /api/assets/:id/schedule`,
`POST /api/assets/:id/scrap`, `DELETE /api/assets/:id`, `POST /api/assets/depreciation?period=`.

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
`redirect_uri` trebuie să fie accesibil public (ex: `http://161.97.152.82:8080/api/anaf/callback`).

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

**Import extras bancar (CSV / MT940):** cardul „Import extras bancar” (tab Documente) citește
tranzacțiile (auto-detectare delimitator/coloane pentru CSV; tag-uri `:61:`/`:86:` pentru
MT940), **potrivește partenerul** după descriere (nume/CUI) și propune încasări/plăți
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
  selectată sunt derivate din profilul firmei (plătitor de TVA → D300/D394 + D406 anual; are
  angajați → D112; lună de trimestru → D100), cu **termen de depunere** (25 ale lunii următoare;
  SAF-T anual — sfârșit de februarie). Descărcarea XML-ului marchează automat „**generată**";
  manual se marchează „**depusă**" (cu nr. recipisă), „**eroare**" sau „**scutită**". Stările nu se
  retrogradează la re-descărcare. API: `GET /api/declarations?period=` · `POST /api/declarations/set`.
- **Portofoliu** (tab dedicat, vizibil cu ≥2 firme): vedere agregată peste toate firmele
  utilizatorului — declarații așteptate/depuse/nedepuse/erori pe lună, **% conformitate**,
  **top firme cu atenționări** (restanțe + erori), tabel per firmă și activitate recentă (din
  jurnalul de audit). `GET /api/portfolio?period=`.
- **Notificări termene fiscale** (🔔 în bara de sus, cu badge): restanțele și termenele din
  următoarele 7 zile, pe toate firmele accesibile, scanând ultimele 3 luni. O declarație dispare
  când e marcată depusă/scutită. `GET /api/notifications`.
- **Digest zilnic pe email** (~07:00): fiecare utilizator cu email setat primește restanțele și
  termenele apropiate de pe firmele lui — prin SMTP-ul din Setări sau, în lipsă, prin **Resend**
  (`RESEND_API_KEY` din `.env`). Opt-out per utilizator din Setări → „Contul meu".
  Declanșare manuală (admin): `POST /api/notifications/digest`.
- **Fișa Rol din SPV** (card în „Declarații ANAF"): solicită de la ANAF **fișa pe plătitor** prin
  serviciile web SPV (`SPVWS2/rest/cerere?tip=Fisa Rol`, documentate în ClientSPV-ul oficial ANAF);
  răspunsurile (PDF) se listează din mesajele SPV și se atașează ca documente ale firmei. Necesită
  conexiunea SPV (OAuth) din Setări. API: `POST /api/anaf/fisa-rol` · `GET /api/anaf/spv-mesaje` ·
  `POST /api/anaf/spv-descarca/:id`.

## Aliniere la ghidul profesional (ediția 2026)

- **Parametri fiscali 2026** (`src/fiscal.js`, tab „Ghid”): CAS 25%, CASS 10%, impozit 10%,
  CAM 2,25%, salariu minim 4.050/4.325 (construcții 4.582), sumă neimpozabilă 300/200, TVA
  21%/11%, micro 1%, profit 16%, dividende 10%. Cota TVA implicită este acum **21%**.
- **Calcul automat al salariilor:** la „Stat de plata” introduci doar brutul (și opțional suma
  neimpozabilă); CAS/CASS/impozit/CAM se calculează automat (lași câmpurile goale).
- **Plan de conturi extins** la lista din ghid (secțiunea 17): 211, 231, 267, 2678, 2813, 280,
  331, 332, 106, 167, 1687, 4418, 457, 471, 472, 711, 712, 8031 etc. (108 conturi).
- **Tipuri de document din monografii:** avans încasat client (419) / avans plătit furnizor
  (409); construcții — lucrări în curs (332=712) și garanție de bună execuție (2678);
  HoReCa — intrare la preț de vânzare (371/378/4428) și vânzare amănunt cu descărcare;
  comerț intracomunitar — diferențe de curs (765/665); transport — combustibil cu TVA 50%,
  amortizare transport (2813), rovinietă (635=446).
- **Tab „Ghid”:** parametri fiscali, glosar de termeni și întrebări frecvente.
- **Conturi analitice pe partener** (`src/analytic.js`, tab „Analitic”): detalierea conturilor
  de terți (401, 4111, 404, 419, 409…) pe analitice per partener (401.01, 401.02…), cu
  **sold inițial, rulaje și sold final**. Soldurile inițiale pe partener se introduc în
  același tab; aplicația verifică automat că suma lor concordă cu soldul inițial sintetic.
  Export PDF.
- **Registrul de evidență fiscală** (card în „Situații financiare”): trecerea de la rezultatul
  contabil la cel fiscal → impozit pe profit 16% vs. micro 1%; export PDF. Aplică **deductibilitatea
  parțială** (art. 25-28 Cod fiscal): amenzi/penalități (6581) și pierderi din creanțe (654)
  **nedeductibile 100%**, ajustări pentru deprecierea creanțelor (6814) **nedeductibile 70%**
  (deductibil 30%), iar reluarea ajustărilor (7814) **neimpozabilă 70%** (simetric); amortizarea
  (art. 28) e marcată ca fiscală = contabilă (fără diferență). Fiecare rând arată baza × procent.
- **Analitice și pe conturi non-partener** (trezorerie 5121/5311…, salarii 421): se detaliază
  după o etichetă liberă pe înregistrare (ex. „BCR”, „Ion Popescu”), nu după partener. Câmpul
  „Analitic” apare pe tipurile de trezorerie și salarii; soldul inițial analitic le acoperă pe toate.
- **Jurnal de bancă / Registru de casă** (tab „Bancă/Casă”): mișcările unui cont de trezorerie
  (5121/5311/5124/5314), cu sold curent (running balance), sold inițial și rulaje; export PDF.
- **Note explicative generate automat** (card în „Situații financiare”): 8 note derivate din
  bilanț/cont de profit și pierdere — active imobilizate, circulante, capitaluri, datorii,
  rezultat, repartizarea profitului (rezervă legală 5%), indicatori (lichiditate, solvabilitate,
  rentabilitate) și principiile contabile; export PDF.
- **Demo aliniat la exemplul integrat din ghid (secțiunea 11):** solduri inițiale (371, 5121,
  5311, 1012, 117, 401), reproducând balanța din ghid — SI 65.000, rulaje 76.392,50, SF
  84.327,50 — cu TVA de plată 840 și profit 687,50.

## Tipuri de documente acceptate

Vânzări (mărfuri, produse, servicii, bon Z, livrare intracomunitară), cumpărări
(mărfuri, materii, utilități, servicii, combustibil, imobilizări, achiziție
intracomunitară cu taxare inversă), trezorerie (încasări/plăți casă/bancă, viramente,
comisioane), salarii (stat de plată cu CAS/CASS/impozit/CAM, plata netă), amortizare și
**notă contabilă liberă** (orice `debit = credit`, pentru orice monografie).

## Arhitectură

- `server.js` — server Express + rute API și PDF.
- `src/chartOfAccounts.js` — planul de conturi (clasele 1–8) + regula debit/credit.
- `src/documentTypes.js` — tipurile de documente și formulele contabile.
- `src/extractor.js` — extragere text din PDF (pdf-parse + pdf2json) și euristici RO.
- `src/fiscal.js` — parametri fiscali 2026 + calculul salariului din brut (CAS/CASS/impozit/CAM).
- `src/aiExtractor.js` — extragere cu Claude API (document PDF + ieșire structurată).
- `src/reporting.js` — livrabile (oglinda borderoului de primire): recap D112/D300/D100, obligații ANAF, registru-inventar.
- `src/xml.js` — generare XML: e-Factura UBL 2.1 (CIUS-RO) pentru facturi emise, D300 și D394 (format ANAF).
- `src/saft.js` — generare SAF-T (D406): Header + MasterFiles (conturi, clienți, furnizori, TVA, mijloace fixe) + GeneralLedgerEntries + SourceDocuments.
- `src/assets.js` — registrul de mijloace fixe + amortizare liniară/degresivă/accelerată (calcul lunar, plan, înregistrare 6811=281x).
- `src/stocks.js` — gestiunea stocurilor cantitativ-valoric la cost mediu ponderat (CMP): fișă de magazie, stoc curent.
- `src/payroll.js` — salarizare: nomenclator angajați (cu **spor** impozabil, **avans** → 425 și
  **rețineri** din net → 427) + stat de plată per angajat (CAS/CASS/impozit/CAM, rest de plată),
  PDF stat + **fluturaș per
  angajat** (`/pdf/fluturas/:id`) + articol contabil agregat + **D112 XML** (tab „Salarizare").
  API: `GET/POST/DELETE /api/angajati`, `GET/POST /api/stat-plata`. **Plata efectivă** a salariilor
  (rest de plată → `421 = 5121`/`5311`) cu un click: `POST /api/stat-plata/pay?period=&cont=`.
  La fiecare înregistrare a statului se salvează un **instantaneu lunar** (`payrollHistory`), din care
  se construiește **registrul anual de salarii** (cumul per angajat, bază pentru adeverințe de venit):
  `/api/registru-salarii?year=`, `/pdf/registru-salarii?year=`. Din registru se generează
  **adeverința de venit** per angajat (`/pdf/adeverinta/:id?year=`) — venit brut/net anual + contribuții,
  cu formular oficial și rubrici de semnătură.
- `src/accounting.js` — jurnal, carte mare, balanță, închideri TVA/anuală.
- `src/analytic.js` — balanță analitică pe partener/etichetă + **scadențar cu vechimea soldurilor (aging)**:
  solduri restante per partener, repartizate pe intervale **0-30 / 31-60 / 61-90 / >90 zile** prin
  stingere FIFO a facturilor cu plățile (factura cea mai veche se stinge prima), la o dată de referință
  (`?asOf=`). `/api/aging`, `/pdf/aging`, `/csv/aging`, card în tab-ul Analitic.
  Pe baza creanțelor &gt;90 zile se poate înregistra **ajustarea pentru deprecierea creanțelor**
  (`6814 = 491`, sau reluare `491 = 7814` la diminuare), cu procent configurabil; `/api/provizion`.
  Creanțele neîncasabile se pot **scoate din evidență** direct din scadențar (buton „scoate"):
  `654 = 4111` (pierdere) + reluarea automată a ajustării aferente `491 = 7814`; `/api/writeoff`.
- `src/statements.js` — cont de profit și pierdere, bilanț.
- `src/pdf.js` — generarea rapoartelor PDF (PDFKit).
- `src/csv.js` — export CSV compatibil Excel (separator `;`, BOM UTF-8) pentru mișcări de stoc,
  stoc curent, registrul-jurnal, balanță, **cartea mare** (cu sold inițial/final și mișcări),
  **balanța analitică** și **parteneri** (`/csv/stock-movements`, `/csv/stocks`, `/csv/journal`,
  `/csv/balance`, `/csv/ledger`, `/csv/analytic`, `/csv/partners`); butoane „⬇ CSV” în tab-uri.
- `src/db.js` — stocare în `data/db.json` (fără server de bază de date).
- `public/` — interfața web (HTML/CSS/JS vanilla).

## Multi-firmă

Aplicația gestionează **mai multe firme** în aceeași instanță:
- Tabelul `firme` (în `data/db.json`) ține firmele; câmpul **`firmaId`** este adăugat la
  toate înregistrările (entries, documents, partners, solduri inițiale sintetice și analitice).
- **Firma activă** se alege din selectorul din bara de sus; toată aplicația (rapoarte, jurnale,
  balanță, declarații, parteneri, reconciliere, dashboard) este filtrată automat pe ea, printr-o
  „vedere” scoped — modulele de raportare nu au fost modificate.
- Gestionarea firmelor (adăugare, activare, ștergere) e în Setări → „Firme”.
- Bazele vechi (o singură firmă, fără `firmaId`) sunt **migrate automat** la prima pornire.
- e-Factura, D300/D394 și trimiterea în SPV folosesc datele firmei căreia îi aparține înregistrarea.
- API: `GET/POST /api/firme`, `POST /api/firme/:id`, `POST /api/firme/:id/activate`,
  `DELETE /api/firme/:id`; orice rută acceptă și `?firma=ID` pentru a forța o firmă anume.
- **Export / import firmă** (migrare/arhivare): `GET /api/firme/:id/export` descarcă un pachet JSON cu
  toate datele firmei; `POST /api/firme/import` îl încarcă **ca firmă nouă**, remapând toate id-urile
  și referințele interne (entries↔mișcări, produse, gestiuni, mijloace fixe, angajați, inventare,
  istoric salarii). Buton în Setări → Firme.

## Utilizatori și autentificare

Aplicația cere **login** și aplică **drepturi pe firmă**:
- Tabelul `users` în `data/db.json`: `{ id, username, salt, hash, role, firme[] }`. Parolele sunt
  hash-uite cu **scrypt** + salt; sesiunea e un **cookie semnat HMAC** (`sid`, HttpOnly, 7 zile).
- Roluri: **admin** (vede toate firmele, gestionează utilizatori) și **user** (vede doar firmele
  alocate). Toate rutele `/api`, `/pdf`, `/xml` sunt protejate; rapoartele sunt filtrate pe firma
  activă a utilizatorului, iar `?firma=ID` e ignorat dacă nu are acces.
- La prima pornire se creează automat **admin / admin** (schimbă parola imediat din Setări →
  „Schimbă parola”; aplicația te avertizează).
- Gestionarea utilizatorilor (adăugare, rol, firme alocate, resetare parolă) e în Setări →
  „Utilizatori” (doar admin). Module: `src/auth.js`.
- API: `POST /api/login` · `POST /api/logout` · `GET /api/me` · `POST /api/change-password` ·
  `GET/POST /api/users` · `POST /api/users/:id` · `DELETE /api/users/:id`.
- **Cookie Secure automat pe HTTPS:** serverul citește `X-Forwarded-Proto` de la reverse proxy
  (`trust proxy`); pe HTTPS cookie-ul de sesiune primește flag-ul `Secure`, pe HTTP nu (ca să
  funcționeze și acum, înainte de certificat).
- **Jurnal de audit** (`audit` în db): acțiunile importante (creare/ștergere înregistrări,
  închideri, firme, utilizatori, login) cu autor, firmă și dată. Vizibil în Setări → „Jurnal de
  audit” (adminul vede tot, userul doar firmele lui). `GET /api/audit`.
- **Invitații prin link:** adminul creează o invitație (Setări → „Utilizatori” → „Trimite
  invitație”); rezultă un link `/?invite=TOKEN` pe care îl trimite (manual sau pe email dacă SMTP
  e configurat în `settings.smtp`). Invitatul deschide linkul, își setează parola și e autentificat.
  API: `POST /api/invites` · `GET /api/invite/:token` · `POST /api/invite/accept`.
- **SMTP real:** Setări → „Server email (SMTP)” (admin) configurează host/port/SSL/user/parolă/from;
  când e completat, invitațiile se trimit automat pe email (prin `nodemailer`). `GET/POST /api/smtp`.
- **Expirarea invitațiilor:** fiecare invitație expiră în **7 zile** (`inviteExp`); după expirare
  linkul nu mai funcționează și adminul trebuie să trimită altul.
- **2FA (TOTP):** Setări → „Autentificare în doi pași” — activezi cu o aplicație de autentificator
  (Google Authenticator/Authy/FreeOTP), scanezi codul (sau introduci secretul) și confirmi cu un cod.
  La login se cere și codul de 6 cifre. Implementare standard RFC 6238 fără dependențe externe
  (`src/totp.js`). API: `POST /api/2fa/setup` · `/api/2fa/enable` · `/api/2fa/disable`.
- **Anti-brute-force la login:** după 8 încercări eșuate de pe același IP, login-ul e blocat ~15
  minute (răspuns `429`). Contorul se resetează la prima autentificare reușită.
- **„Remember device” pentru 2FA:** la login cu cod poți bifa „Ține minte acest dispozitiv 30 de
  zile” → un cookie semnat `tfd` sare peste codul 2FA pe acel dispozitiv. „Revocă dispozitivele de
  încredere” (sau dezactivarea 2FA) le invalidează pe toate (`tfdEpoch`).
- **Backup automat al bazei de date:** Setări → „Backup” (admin) — buton „Fă backup acum”, listă cu
  descărcare, și **backup automat zilnic**. Mecanism: `src/backup.js` (`backupNow`) copiază `data/db.json`
  în `data/backups/db-YYYYMMDD-HHMMSS.json` și păstrează ultimele 30. Rularea zilnică e făcută de
  `scripts/backup.js` printr-un **cron** (`30 3 * * * node /var/www/contab/scripts/backup.js`,
  log în `data/backups/backup.log`). API: `POST /api/backup` · `GET /api/backups` ·
  `GET /api/backup/file/:name` · `POST /api/backups/auto`.
- **Arhivă completă + copie offsite (zilnic):** pe lângă copia `db.json`, cronul creează
  `data/backups/full-YYYYMMDD-HHMMSS.zip` — `db.json` + un **instantaneu consistent** al bazei
  SQLite (`VACUUM INTO`, sigur sub WAL) + **toate documentele din `data/uploads/`** — păstrează
  ultimele 14 și o trimite **în afara serverului**: pe email (Resend, `CONTAB_BACKUP_EMAIL_TO` +
  `RESEND_API_KEY` în `.env`) și/sau cu **rclone** (`RCLONE_REMOTE`, obligatoriu peste 20MB).
  Restaurare după dezastru: dezarhivezi zip-ul → `db.json` prin Setări → Backup → Restaurează,
  `uploads/*` înapoi în `data/uploads/`.
- **Restaurare backup din UI:** Setări → „Backup” → încarcă un fișier `db.json`; serverul îl
  validează (trebuie să conțină `firme`/`users`), face automat un backup al stării curente, apoi
  înlocuiește baza și o reîncarcă. `POST /api/restore` (admin, multipart).
- **Resetare parolă prin email:** „Ai uitat parola?” pe ecranul de login → introduci utilizator/email
  → primești un link `/?reset=TOKEN` (valabil 1 oră) dacă ai email setat și SMTP e configurat.
  Răspunsul e identic indiferent dacă există contul (nu dezvăluie utilizatorii). Setezi emailul în
  Setări → „Contul meu”. API: `POST /api/forgot-password` · `GET /api/reset/:token` ·
  `POST /api/reset/accept` · `GET/POST /api/profile`.
- **Sesiuni active + „deconectează peste tot”:** sesiunile sunt înregistrate server-side (dispozitiv,
  IP, ultima activitate); cookie-ul de sesiune e legat de un `sessId` — dacă sesiunea e revocată,
  cookie-ul devine invalid. Setări → „Contul meu” arată sesiunile, cu „deconectează” per dispozitiv și
  „Deconectează celelalte dispozitive”. Resetarea parolei deconectează automat toate sesiunile.
  API: `GET /api/sessions` · `POST /api/sessions/logout-others` · `DELETE /api/sessions/:id`.

## Note

- Datele se păstrează în `data/db.json`; fișierele PDF încărcate în `data/uploads/`.
- **Uploadurile sunt validate** (allowlist de extensii: PDF, imagini, CSV/TXT, XLS(X), DBF, XML,
  ZIP, JSON — HTML/JS/SVG sunt respinse, anti-XSS stocat). La descărcare, doar tipurile inerte
  (PDF/imagini) se afișează inline; orice altceva se descarcă forțat ca octeți. Accesul la
  `/api/document/:id/file` e restricționat la firmele alocate utilizatorului.
- **Oglinda JSON** (`data/db.json`) se scrie cu întârziere de max. 30s după modificări (debounce);
  SQLite e mereu la zi. Backupul manual și oprirea curată (SIGINT/SIGTERM) o aduc la zi întâi.
- Cotele și tratamentele sunt simplificate pentru claritate; situațiile concrete pot
  necesita conturi și prelucrări suplimentare conform Codului fiscal.
- Extragerea din PDF funcționează pe documente cu **text** (PDF-uri generate de programe
  de facturare). Pentru PDF-uri scanate (imagine) datele se pot introduce manual —
  câmpurile rămân editabile, iar documentul se atașează ca justificativ.
