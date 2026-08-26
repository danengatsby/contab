# Contabo — texte de prezentare

Material de marketing pentru site, reclame și rețele sociale. **Fiecare cifră și fiecare
funcție de mai jos e verificată în cod** — nu promite nimic ce aplicația nu face.

Pagina de destinație construită din acest text (privată până o publici din meniul de partajare):
<https://claude.ai/code/artifact/1284ea8f-4bfe-441f-9963-44e2f1f1e579>

**La fiecare actualizare, reverifică cifrele** — sunt singurele lucruri de aici care pot drifta:
`Object.keys(require('./src/documentTypes').TYPES).length` (tipuri de operațiuni),
`Object.keys(require('./src/declarations').TIPURI).length` (declarații în registru),
prețurile din `src/plans.js` și totalul afișat de `npm test`.

---

## 1. Pitch scurt (pentru bio, meta description, reclame)

**280 de caractere**
> Contabilitate românească completă, într-un singur loc. Tragi factura — Contabo pune conturile,
> ține registrele, calculează TVA-ul și îți pregătește D300, D394, D112, e-Factura și SAF-T.
> Formatele fiscale suportate trec prin poarta de validare ANAF/XSD la fiecare versiune.
> 30 de zile gratuit, fără card.

**O frază**
> Aduci documentele, Contabo face contabilitatea — de la poza facturii până la declarația
> validată de ANAF.

**Cinci cuvinte**
> Contabilitate care se verifică singură.

---

## 2. Antetul paginii (hero)

# Contabilitatea firmei tale, de la poză la declarație

**Tragi factura în aplicație. Contabo alege conturile, ține registrele, calculează TVA-ul și
îți pregătește declarațiile pentru ANAF. Tu doar verifici și confirmi.**

`[ Începe gratuit — 30 de zile, fără card ]`   `[ Intră în contul demo ]`

*Contabilitate românească în partidă dublă · OMFP 1802/2014 · parametri fiscali 2026*

---

## 3. Trei cifre care spun tot

| | |
|---|---|
| **137** | tipuri de operațiuni gata pregătite — alegi în limbaj simplu, aplicația pune conturile |
| **14** | declarații și situații în registru: D300, D301, D307, D311, D394, D390, D205, D112, D100, D101, D107, SAF-T (D406), Intrastat, bilanț |
| **mii** | de controale automate rulate la fiecare versiune, fără o cifră care se învechește după fiecare test nou |

---

## 4. Pentru patroni de firme

### Nu trebuie să știi contabilitate. Trebuie să știi cum stai.

Ai o firmă, nu o facultate de contabilitate. Întrebările tale sunt simple, dar răspunsurile vin
târziu: *cât profit am făcut luna asta? câtă taxă am de plătit? îmi permit angajarea asta? cine
îmi datorează bani și de când?*

Contabo îți răspunde **în timp real**, nu peste trei săptămâni.

**Cum arată o zi obișnuită**

1. Ai primit o factură de la furnizor. O fotografiezi cu telefonul și o tragi în aplicație.
   Furnizorul, CUI-ul, baza, TVA-ul și totalul se completează singure. Tu verifici și salvezi.
2. Emiți o factură unui client. Completezi liniile; primești **PDF-ul pentru client** și
   **e-Factura XML pentru SPV**, cu numărul în serie continuă.
3. La final de lună apeși „Regularizează TVA". Decontul D300 este pregătit pentru verificare,
   defalcat pe cote; luna se blochează separat, la finalul cockpitului.

**Ce vezi, oricând**

- Profitul, taxele și banii disponibili — actualizate la fiecare document înregistrat
- Cine îți datorează bani, de câte zile, cu scadențar pe vechimi
- Comparație an-la-an, buget vs. realizat, previziune de încasări
- Micro (1%) sau impozit pe profit (16%) — ambele calcule, alături, ca să alegi în cunoștință de cauză

> **Nu înlocuiește contabilul — îl face mai ieftin.** Când documentele sunt deja înregistrate
> corect și declarațiile deja pregătite, contabilul verifică și semnează, în loc să introducă
> date. Plătești pentru expertiză, nu pentru tastare.

---

## 5. Pentru contabili

### Portofoliul întreg, pe un singur ecran

Dacă ții zece firme, cea mai scumpă întrebare nu e „cum se înregistrează asta" — e **„care firmă
are o restanță despre care nu știu"**. Contabo îți răspunde fără să deschizi fiecare dosar.

**Ce câștigi**

- **Multi-firmă strict izolat.** Comuți dintr-un selector; fiecare firmă cu datele, partenerii,
  seriile și declarațiile ei.
- **Tabloul de conformitate.** Ce e depus, ce e restant, cine are erori — agregat peste tot
  portofoliul, cu procentul de conformitate și firmele cu atenționări în frunte.
- **Digest zilnic pe e-mail** cu restanțele și termenele din următoarele 7 zile, pe toate firmele.
- **Registrul depunerilor.** Fiecare declarație cu termenul ei legal; descărcarea XML-ului o
  marchează „generată", tu o marchezi „depusă" cu numărul recipisei.
- **Închiderea lunară ca flux unic.** Documente → extras bancar → TVA → declarații → aprobare →
  blocare. Starea fiecărui pas **se derivă din date**, nu se bifează manual: o bifă ar rămâne
  adevărată și după ce datele se schimbă.
- **Import din programul vechi.** Balanță din XLS, XLSX, DBF sau CSV, solduri pe fiecare client
  și furnizor, stoc cantitativ-valoric.
- **Jurnal de audit** append-only, care supraviețuiește rulajului bazei — proba de control intern.

**Munca mecanică dispare, controlul rămâne**

Citirea automată a documentelor trece printr-o baterie de controale înainte să fie acceptată:
aritmetica (bază + TVA = total), cota, data (inclusiv perioadă închisă), numărul documentului,
partenerul cunoscut, duplicatul, gradul de încredere. **Postarea automată e OPRITĂ implicit** —
se activează doar dacă o ceri explicit, și doar dacă trec toate controalele.

---

## 6. Ce primești, pe scurt

**Documente și facturare** — 137 tipuri de operațiuni · facturi cu serie continuă · e-Factura UBL
pentru SPV, cu trimitere și recipisă · import e-Factura primită · avize, facturi simplificate,
facturi de avans · e-Transport (cod UIT)

**TVA și declarații** — jurnale de vânzări/cumpărări defalcate pe cote · TVA la încasare · taxare
inversă · pro-rata (art. 300) · D300, D394, D390, D205, D112, D100, D101, SAF-T (D406), Intrastat
· validare înainte de depunere · reconciliere cu decontul precompletat e-TVA

**Registre și situații financiare** — registru-jurnal · cartea mare · balanță cu cele patru
egalități · bilanț F10, profit și pierdere F20, fluxuri de trezorerie F30, capitaluri proprii F40
+ note explicative, într-un singur PDF

**Stocuri și producție** — gestiuni la cost mediu ponderat sau FIFO · NIR, bon de consum, aviz ·
inventar cu proces-verbal · rețete/BOM și producție · descărcare automată de gestiune la vânzare

**Salarizare** — state de plată cu cotele 2026 · deducere personală · concedii medicale și de
odihnă · tichete și avantaje în natură · fluturași, adeverințe · D112

**Bancă și casă** — import extras CSV/MT940/CAMT.053 · IBAN, monedă, solduri și hash păstrate ·
protecție la reimport · punctaj document-cu-document · diferență zero înainte de închiderea lunii ·
plafon de casierie · fișier de plăți SEPA (pain.001) · curs BNR automat

**Imobilizări** — registru de mijloace fixe · amortizare liniară, degresivă, accelerată ·
amortizare fiscală separată de cea contabilă · leasing financiar cu grafic de rate

**Siguranță** — cont propriu cu parolă și 2FA · jurnal de audit · backup zilnic automat cu copie
în afara serverului · exercițiu de restaurare verificat periodic

---

## 7. De ce poți avea încredere

### Formatele fiscale suportate trec prin poarta oficială de validare

Nu spunem „conform ANAF" și atât. **Înainte ca o versiune să ajungă la tine**, fișierele de
referință pentru formatele fiscale menținute sunt trecute prin **DUKIntegrator — validatorul
publicat de ANAF** — sau prin schema oficială XSD aplicabilă. Dacă un fișier din perimetrul porții
este respins, versiunea nu se publică.

Mai mult: dacă validarea *nu poate rula* (serviciul ANAF e picat, schema lipsește), versiunea tot
nu se publică. **„N-am putut verifica" nu înseamnă „e bine".**

### Mii de verificări automate, la fiecare versiune

Balanțe care trebuie să se închidă, TVA pe fiecare cotă, salarii pe grila în vigoare, închideri de
lună și de an, escapare corectă în XML-urile care pleacă la ANAF. Toate rulează automat, de fiecare
dată.

### Cifrele fiscale sunt datate și centralizate

Cotele nu sunt scrise prin cod, ci într-un singur loc, cu data de la care se aplică: TVA 21%/11%,
dividende 16%, micro 1%, salariul minim cu comutare automată la 1 iulie, deducerea personală după
grila în vigoare. Se pot și ajusta manual, dacă legea se schimbă înaintea noastră.

---

## 8. Prețuri

### Toate funcțiile, în fiecare plan

| | **Probă** | **Start** | **Pro** |
|---|---|---|---|
| | 30 de zile, **fără card** | **99 lei/lună/firmă** | **99 lei/lună/firmă** |
| Pentru | testezi tot | antreprenori care își țin singuri evidența | contabili și portofolii de firme |
| Funcții | toate | toate | toate |
| Mod implicit | simplu | simplu | expert |

**Fără module plătite separat.** Stocurile, producția, salarizarea și declarațiile sunt incluse din
prima zi. Start și Pro au același preț și același motor contabil; Pro pornește în modul expert și
este prezentat pentru fluxul de portofoliu — fără să inventăm o limitare artificială pentru Start.

**După probă, datele rămân.** Alegi un plan și continui exact de unde ai rămas.

`[ Începe proba gratuită ]` — durează două minute și nu cere card.

---

## 9. Ce face aplicația — și ce rămâne la tine

Preferăm să știi dinainte. Contabo este un **asistent contabil cu validare umană**: pregătește
evidența și formatele cerute de ANAF, fără să garanteze singur corectitudinea fiscală. Ultimii pași rămân în grija ta:

- **Validează declarațiile** cu DUKIntegrator înainte de depunere — până atunci sunt ciorne.
- **Verifică sumele și încadrările cu un contabil autorizat.** Aplicația calculează; răspunderea
  fiscală rămâne a ta.
- **Depunerea în SPV** se face de tine și cere certificat digital ANAF.
- **Casa de marcat fiscală** rămâne obligatorie separat, pentru încasările în numerar de la populație.
- **Păstrează documentele originale** conform termenelor legale — în general 5 ani (Legea 36/2023).

---

## 10. Întrebări frecvente

**Trebuie să știu contabilitate?**
Nu. Alegi tipul documentului în limbaj obișnuit — „factură de la furnizor", „încasare de la
client" — iar aplicația pune conturile corecte. Există ghid pas cu pas și tur ghidat la prima
autentificare.

**Ce se întâmplă după cele 30 de zile?**
Datele rămân. Alegi un plan și continui de unde ai rămas. Nimic nu se pierde.

**Pot ține mai multe firme?**
Da. Aplicația e multi-firmă, cu date strict izolate între ele, iar tabloul Portofoliu îți arată
conformitatea pe toate deodată.

**Am deja o firmă cu istoric. Cât de greu e să mă mut?**
Imporți balanța din programul vechi (XLS, XLSX, DBF sau CSV), soldurile pe clienți și furnizori și
stocul cantitativ-valoric. Continui din luna curentă.

**Datele mele sunt în siguranță?**
Cont propriu cu parolă și, opțional, autentificare în doi pași. Jurnal de audit al acțiunilor.
Backup zilnic automat, cu o copie păstrată în afara serverului, și exercițiu de restaurare rulat
periodic — ca să știm că backupul chiar se poate restaura, nu doar că există.

**Sunt la zi cotele?**
Da, parametrii 2026. Și sunt configurabili, dacă legea se schimbă între versiuni.

---

## 11. Închidere

### Începe cu firma ta, azi

Prima factură înregistrată durează sub un minut. Prima declarație pregătită — cât să apeși un
buton. Restul lunii îl petreci conducând firma, nu căutând acte.

`[ Începe gratuit — 30 de zile, fără card ]`

---

## 12. Facebook — pachet gata de publicat

**Cum se citește secțiunea asta.** Facebook **nu randează markdown**: nu copia asteriscuri,
diez sau liniuțe de listă — textele de mai jos sunt deja în text simplu, cu rânduri goale ca
separatori. Pe mobil se văd **primele ~125 de caractere** înainte de „Vezi mai mult", deci prima
linie e singura garantată. Emoji-urile sunt puse rar, ca reper vizual, nu ca decor.

Patronii și contabilii se targetează separat — de aceea au postări și reclame diferite, nu una
comună care nu vorbește cu niciunul.

---

### 12.1 Descrierea paginii

**Scurtă (bio, sub numele paginii)**

```
Contabilitate românească completă: de la poza facturii până la declarația pentru ANAF.
```

**Lungă (secțiunea „Despre")**

```
Contabo e o aplicație de contabilitate românească în partidă dublă, făcută pentru firme mici și
pentru contabilii care le țin.

Tragi factura în aplicație — Contabo alege conturile, ține registrele, calculează TVA-ul și îți
pregătește D300, D394, D112, e-Factura și SAF-T. Tu verifici și confirmi.

137 tipuri de operațiuni gata pregătite. Stocuri, producție, salarizare și cele 14 declarații și
situații din perimetrul listat sunt incluse în orice plan — fără module plătite separat.

Înainte ca o versiune să ajungă la tine, fișierele fiscale de referință din perimetrul suportat
trec prin DUKIntegrator sau schema XSD aplicabilă. Poarta verifică forma tehnică și corelațiile
validatorului, nu încadrarea fiscală ori substanța cifrelor firmei.

30 de zile gratuit, fără card. contabo.space
```

---

### 12.2 Postarea fixată

```
Cât profit ai făcut luna trecută?

Dacă răspunsul vine peste trei săptămâni, de la contabil, e prea târziu ca să mai schimbi ceva.

Contabo îți arată profitul, taxele și banii disponibili după fiecare document înregistrat. Tragi
factura în aplicație — furnizorul, baza și TVA-ul se completează singure. La final de lună apeși
„Regularizează TVA", iar decontul D300 este pregătit pentru verificare, defalcat pe cote.

137 tipuri de operațiuni. Cele 14 declarații și situații listate sunt incluse. Fără module plătite separat.

30 de zile gratuit, fără card 👉 contabo.space
```

*Imagine: captură din aplicație cu tabloul de bord — profit, TVA de plată, bani disponibili.*

---

### 12.3 Postări pentru calendar

Fiecare are o singură idee. Prima linie e cârligul; restul se vede după „Vezi mai mult".

**1 · Durerea patronului**
```
„Îți spun după ce închid luna."

Cea mai scumpă propoziție din relația cu contabilul tău. Nu pentru că el greșește — ci pentru că
decizia pe care o aveai de luat era săptămâna trecută.

În Contabo, fiecare document înregistrat actualizează imediat profitul, taxele și banii
disponibili. Nu aștepți raportul. Te uiți.

30 de zile gratuit, fără card → contabo.space
```

**2 · Durerea contabilului**
```
Zece firme. Zece termene. Zece dosare de deschis ca să afli cine are restanțe.

Sau un singur ecran care ți le arată pe toate: ce e depus, ce e restant, cine are erori — cu
procentul de conformitate pe tot portofoliul.

În plus, un digest zilnic pe e-mail cu termenele următoarelor 7 zile, pe toate firmele deodată.

contabo.space
```
*Imagine: captură din tabul Portofoliu.*

**3 · Încrederea (cea mai puternică)**
```
Majoritatea programelor de contabilitate scriu „conform ANAF".

În fiecare versiune, fișierele fiscale de referință din perimetrul suportat trec prin
DUKIntegrator sau schema XSD aplicabilă. Dacă un fișier este respins, versiunea nu se publică.

Iar dacă validarea tehnică nu POATE rula — serviciul ANAF e picat, schema lipsește — versiunea tot
nu se publică. Validarea formei nu confirmă însă tratamentul fiscal sau substanța cifrelor firmei.

contabo.space
```

**4 · Citirea automată**
```
Fotografiezi factura. O tragi în aplicație. Gata.

Furnizorul, CUI-ul, baza, TVA-ul și totalul se completează singure.

Înainte de a fi acceptată, citirea trece prin verificări de aritmetică, cotă, dată, număr de
document, partener cunoscut și duplicat. Tu confirmi — postarea automată e oprită până când o
ceri tu.

Automatizare, nu ghicit. contabo.space
```
*Video scurt: PDF tras în aplicație → câmpurile se completează.*

**5 · Onestitatea (convertește mai bine decât încă cinci funcții)**
```
Ce NU face Contabo.

Nu depune declarațiile în locul tău — depunerea în SPV o faci tu, cu certificat digital.
Nu înlocuiește casa de marcat fiscală.
Nu înlocuiește contabilul autorizat: aplicația calculează, răspunderea fiscală rămâne a ta.

Ce face: îți dă contabilitatea gata făcută și declarațiile gata pregătite, ca omul care le
verifică să nu mai piardă timp introducând date.

Plătești pentru expertiză, nu pentru tastare. contabo.space
```

**6 · Prețul**
```
Fără „ups, asta e în alt pachet".

Stocurile, producția, salarizarea și cele 14 declarații și situații listate sunt incluse din prima zi, în orice plan.
Start pornește în modul simplu; Pro pornește în modul expert. Motorul contabil este același.

Start și Pro: 99 lei/lună/firmă. Probă 30 de zile, fără card.

contabo.space
```

**7 · Migrarea**
```
„Am deja o firmă cu istoric. E prea târziu să mă mut."

Nu e. Imporți balanța din programul vechi — XLS, XLSX, DBF sau CSV — plus soldurile pe fiecare
client și furnizor și stocul cantitativ-valoric. Continui din luna curentă.

Aplicația verifică singură echilibrul preluării: dacă debitul nu dă creditul, îți spune unde.

contabo.space
```

**8 · Micro sau profit**
```
Micro 1% sau impozit pe profit 16%?

Micro avantajează marjele mari. Impozitul pe profit poate fi mai bun la marje mici. Iar diferența,
pe an, poate fi cât un salariu.

Contabo îți arată ambele calcule alături, pe cifrele TALE. Decizia o iei cu contabilul — dar o iei
informat, nu după ce a zis cineva pe un grup.

contabo.space
```

**9 · Partida dublă (pentru cei tehnici)**
```
Debit = Credit.

Toată contabilitatea în partidă dublă stă pe egalitatea asta. Dacă nu se închide, ceva e greșit —
și de obicei afli la balanță, peste trei săptămâni.

Contabo o verifică la fiecare înregistrare, nu la final de lună. Plus balanța cu cele patru
egalități, registru-jurnal, cartea mare — generate, nu completate de mână.

contabo.space
```

**10 · e-Factura**
```
e-Factura nu mai e opțională. Iar în Contabo nu e nici măcar un pas separat.

Completezi liniile facturii și primești deodată PDF-ul pentru client și XML-ul UBL pentru SPV, cu
numărul în serie continuă. Trimiți din aplicație și primești recipisa.

Facturile primite se importă la fel de simplu, direct din SPV.

contabo.space
```

---

### 12.4 Reclame (Meta Ads)

Limitele recomandate de Meta se schimbă; verifică-le în Ads Manager înainte de a publica.
Orientativ: text principal citit până la ~125 de caractere, titlu ~40, descriere ~30.

**Set A — patroni de firme**

| câmp | text |
|---|---|
| Text principal | Cât profit ai făcut luna asta? Dacă afli peste trei săptămâni, e prea târziu să mai schimbi ceva. Contabo îți arată profitul, taxele și banii disponibili după fiecare document. 30 de zile gratuit, fără card. |
| Titlu | Contabilitatea firmei, în timp real |
| Descriere | Fără card. 30 de zile. |
| Buton | Încearcă gratuit |

**Set B — contabili**

| câmp | text |
|---|---|
| Text principal | Zece firme, zece termene, zece dosare de deschis. Sau un singur ecran cu tot portofoliul: ce e depus, ce e restant, cine are erori. Plus digest zilnic cu termenele săptămânii. |
| Titlu | Tot portofoliul, pe un ecran |
| Descriere | Multi-firmă. Probă 30 zile. |
| Buton | Află mai multe |

**Set C — încredere (pentru cei care au văzut deja pagina)**

| câmp | text |
|---|---|
| Text principal | Alte programe scriu „conform ANAF". La fiecare versiune, fișierele fiscale de referință suportate trec prin DUKIntegrator/XSD; dacă unul e respins, versiunea nu se publică. Verificarea privește forma tehnică, nu substanța fiscală. |
| Titlu | Validat de validatorul ANAF |
| Descriere | Vezi cum verificăm. |
| Buton | Încearcă gratuit |

---

### 12.5 Capturile — care unde merge

Fișierele sunt în `marketing/capturi/` (PNG pentru arhivă, JPG optimizat pentru publicare). Sunt făcute pe o instanță **izolată**, cu exemplul oficial
din ghid, nu pe contul demo public: acela e **scriibil de oricine** și se resetează zilnic, deci o
captură de acolo publică ce a lăsat ultimul vizitator. La prima încercare, tabloul de bord al
demoului arăta sold negativ, 10 termene depășite și facturi netrimise în SPV.

| fișier | ce arată | pentru |
|---|---|---|
| `fb-1-acasa.png` | tabloul de bord: venituri, cheltuieli, rezultat, TVA de plată, disponibil | postarea fixată, postarea 1 |
| `fb-2-portofoliu.png` | 7 firme, șase la zi și una în lucru, fără restanțe | postarea 2 (contabili) |
| `fb-3-document.png` | ecranul de adăugare document primit | postarea 4 (citirea automată) |
| `fb-4-tva.png` | decont D300 pe iunie: colectată 2.940, deductibilă 2.100, de plată 840, defalcat pe cote | postarea fixată, postarea 10 |
| `fb-5-balanta.png` | balanța cu mesajul „Balanța se închide — cele patru egalități sunt respectate" | postarea 9 |

**Realist, nu 100%.** Portofoliul e construit deliberat cu o firmă rămasă în urmă: un 100% peste tot ar
arăta fals și n-ar semăna cu nicio lună reală.

**Regenerare:** `npm run capturi-marketing`. Comanda pornește o instanță izolată, publică simultan
PNG/JPG în ambele directoare și scrie `capturi-manifest.json`, cu versiunea UI și amprenta surselor.
Cifrele se pot schimba la regenerare; nu le cita în postări fără să te uiți la imagine.

---

### 12.6 Ce merge și ce nu, pe Facebook

- **Prima linie decide.** Restul se citește doar dacă ea a oprit degetul. Nu începe cu „Suntem o
  aplicație de…" — începe cu problema cititorului.
- **O idee pe postare.** Lista de 14 funcții nu se citește. Postarea 6 vinde prețul, postarea 3
  vinde încrederea — nu le amesteca.
- **Capturi reale din aplicație**, nu ilustrații generice cu grafice. Publicul ăsta recunoaște
  imediat o poză de stoc.
- **Postarea de onestitate (5) merită bani de promovare.** Pe o piață plină de exagerări, lista a
  ce NU faci construiește mai multă încredere decât încă cinci funcții — și taie din comentariile
  „dar depune singură?".
- **Răspunde la comentarii cu cifre**, nu cu „vă rugăm să ne scrieți în privat". Întrebarea publică
  a unuia e răspunsul căutat de alți cincizeci.
- **Nu promite ce nu face.** Tot ce e mai sus e verificat în cod. Dacă adaugi ceva, verifică întâi
  în aplicație — o promisiune ratată la ANAF costă mai mult decât o vânzare câștigată.

---

## 13. Variante scurte pentru alte rețele

**Pentru antreprenori**
> Cât profit ai făcut luna asta? Dacă răspunsul vine peste trei săptămâni, de la contabil, e prea
> târziu ca să mai schimbi ceva. Contabo îți arată profitul, taxele și banii disponibili după
> fiecare document înregistrat. 30 de zile gratuit, fără card.

**Pentru contabili**
> Zece firme, zece termene, zece dosare de deschis ca să afli cine are restanțe. Sau un singur
> ecran care ți le arată pe toate. Contabo — multi-firmă, cu tablou de conformitate și digest
> zilnic pe e-mail.

**Despre încredere**
> Cele mai multe programe de contabilitate spun „conform ANAF". La fiecare versiune, fișierele
> fiscale de referință suportate trec prin DUKIntegrator/XSD. Dacă unul e respins, versiunea nu se
> publică; poarta verifică forma tehnică, nu substanța fiscală a datelor firmei.

**Despre preț**
> Fără module plătite separat. Stocuri, producție, salarizare și cele 14 declarații și situații listate sunt incluse
> din prima zi, în orice plan. Start și Pro costă ambele 99 lei/lună/firmă; diferă doar modul implicit, Simplu sau Expert.

**Despre citirea automată**
> Fotografiezi factura, o tragi în aplicație, iar furnizorul, baza și TVA-ul se completează
> singure. Înainte de a fi acceptată, trece prin verificări de aritmetică, cotă, dată, duplicat și
> partener. Tu confirmi — postarea automată e oprită până când o ceri.
