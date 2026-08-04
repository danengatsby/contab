# Scenariu — video de prezentare Contabo

Scenariu de filmare (screencast cu voce), gata de dat unui editor video. **Fiecare afirmație din
voice-over e verificabilă în aplicație** — dacă schimbi ceva aici, verifică întâi în produs, ca la
`PREZENTARE.md`: o promisiune ratată la ANAF costă mai mult decât o vizionare câștigată.

- **Public:** patroni de firme mici (nu știu contabilitate) + contabili cu portofolii de firme.
- **Obiectiv:** o singură idee — *aduci documentele, aplicația face contabilitatea și declarațiile,
  iar ordinea în care lucrezi e chiar ciclul contabil.*
- **Ton:** calm, concret, fără superlative. Se arată ecrane reale, nu ilustrații.
- **Durata:** varianta principală **8:20**, cu voce în română (24 de scene); variante scurte de
  60 s, 30 s și 15 s (capitolul 5).
- **Format:** 1280×720, 25 fps, voce română. Subtitrarea arsă rămâne de adăugat — mulți se uită
  fără sunet.
- **Textul rostit** stă în `scripts/naratiune-video.json` — o singură sursă, din care se generează
  și vocea, și capitolul 3 de mai jos. Dacă schimbi o replică, schimb-o acolo.

---

## 1. Pregătirea filmării

### 1.1 Pe ce instanță se filmează

**NU pe contul demo public.** Demoul de pe contabo.space e scriibil de oricine și se resetează
zilnic — la prima încercare de capturi de marketing, tabloul de bord arăta sold negativ, 10 termene
depășite și facturi netrimise. Se filmează pe o **instanță izolată**, cu exemplul oficial din ghid:

```bash
npm run seed        # firma-exemplu (S.C. EXEMPLU PROD S.R.L.), date pe 2026-06
```

Rețeta completă de pornire a unei instanțe izolate, cu variabilele de mediu și capcanele întâlnite,
e în antetul lui `scripts/capturi-marketing.mjs` — același drum ca la capturile de Facebook. De
acolo se iau și capcanele de filmare, toate întâlnite pe viu:

- luna de lucru e **globală**: exemplul are datele pe iunie, deci se mută luna din bara de sus;
- prima autentificare pe o bază proaspătă cere **schimbarea parolei** — se face înainte de filmare;
- selectorul de firmă e `#firmaSelect`, iar firma activă după creări e **ultima** creată (goală):
  se comută explicit pe firma cu date, altfel decontul iese cu toate zerourile;
- marcarea unei declarații ca „depusă" **blochează perioada** și apare banda de lună închisă peste
  jumătate de ecran — se filmează secvența declarațiilor **la final**, sau se deblochează perioada;
- grupurile din meniu sunt **pliate** implicit; se deschid pe cameră, nu înainte.

### 1.2 Setări de ecran

| | |
|---|---|
| Rezoluție | 1280×720 la 25 fps (înregistrarea Playwright); capturile de marketing rămân 1440×900 |
| Temă | **clară** pentru filmul principal; o singură secvență pe temă întunecată (buton 🌙) |
| Mod | contul de probă pornește în **Simplu**; firma-exemplu, pe contul de admin, e în **Expert** |
| Zoom | 100%; niciun element nu trebuie să depindă de derulare orizontală |
| Cursor | evidențiat discret; clicurile — cu un „puls" vizual în montaj |
| De ascuns | ecranul de bun-venit (`#welcomeOverlay`), notificările toast, extensiile de browser, barele de marcaje |
| Date personale | firma-exemplu, parteneri din seed; **niciun CUI sau nume real** de client |

### 1.3 Ritm

Viteza reală a aplicației e un argument: nu se accelerează ecranele care răspund instant. Se
accelerează (×2, cu marcaj „×2" în colț) **doar** completarea manuală a formularelor lungi.

---

## 2. Structura filmului

Coloana vertebrală e **ciclul contabil**, fiindcă chiar așa e organizat meniul, de sus în jos:

```
Documente & facturi → Bani → Stocuri · Salarii · Mijloace fixe →
Registre contabile → Închideri → Taxe & declarații → Rapoarte & analize
```

Filmul merge exact pe acest drum. Spectatorul învață ordinea o dată și o recunoaște în meniu.

---

## 3. Scenariul, scenă cu scenă

Douăzeci și patru de scene, în ordinea ciclului contabil. Fiecare scenă ține **exact cât vocea ei**:
acțiunile se execută, apoi filmarea așteaptă restul — de aceea imaginea nu fuge înaintea textului.
Timpul din titlu e momentul din film; textul citat e chiar ce se aude.

### 01 · `s01-prezentare` — 0:01 · voce 20 s

**Se vede:** Pagina publică `prezentare.html`: antetul, cele trei cifre, „Nu trebuie să știi formula contabilă".

> Contabo. Contabilitate românească completă, într-un singur loc. Aduci documentele, iar aplicația face contabilitatea: alege conturile, ține registrele, calculează taxele și pregătește declarațiile pentru ANAF. Hai să o vedem, de la primul clic până la declarația gata de depus.

### 02 · `s02-preturi` — 0:21 · voce 26 s

**Se vede:** Secțiunea de prețuri de pe aceeași pagină (Probă / Start / Pro), apoi „Ce face aplicația — și ce rămâne la tine".

> Întâi, prețurile, ca să știi de la început. Ai treizeci de zile de probă, fără card bancar. Apoi, nouăzeci și nouă de lei pe lună pentru planul Start și o sută nouăzeci și nouă pentru Pro. Toate funcțiile sunt incluse în fiecare plan: stocurile, salariile, declarațiile. Planurile se deosebesc prin preț, nu prin funcții, ca să nu descoperi la final de an că lucrul de care ai nevoie e în alt pachet.

### 03 · `s03-cont` — 0:48 · voce 15 s

**Se vede:** Ecranul de autentificare → „🚀 Testează gratuit" → formularul de înscriere, completat pe cameră (patron, denumire, CUI, utilizator, parolă, e-mail) → „Creează firma și contul".

> Contul se face în două minute. Alegi dacă ești patron sau contabil, completezi datele firmei și alegi un utilizator și o parolă. Nu se cere card. La final ai firma ta, cu planul de conturi românesc complet și zero înregistrări.

### 04 · `s04-primaintrare` — 1:04 · voce 19 s

**Se vede:** Ecranul de bun-venit („Hai să-ți pornim firma") și turul meniului, parcurs câțiva pași.

> La prima intrare ești întâmpinat cu trei pași simpli și cu un tur al meniului. Meniul e organizat pe ordinea în care se lucrează, adică pe ciclul contabil: documentele, banii, ce mișcă în fiecare lună, registrele, închiderea lunii, declarațiile și, la final, rapoartele.

### 05 · `s05-comutare` — 1:24 · voce 5 s

**Se vede:** Delogare și intrare pe contul firmei-exemplu, cu luna de lucru pe iunie 2026.

> Ca să vedem aplicația plină, intrăm acum pe o firmă care lucrează deja de câteva luni.

### 06 · `s06-ghid` — 1:31 · voce 13 s

**Se vede:** Tabul **Ghid**, derulat: pașii de lucru și checklistul de conformitate ANAF.

> Dacă nu ai mai ținut contabilitate, începi din Ghid. E scris pe înțelesul oricui și te duce pas cu pas: ce documente aduni, cum le înregistrezi, ce verifici la final de lună și ce depui la ANAF.

### 07 · `s07-acasa` — 1:45 · voce 21 s

**Se vede:** **Acasă**: alertele de sus, „Ce vrei să faci?", cardurile de KPI, comparația an-la-an.

> Acasă e punctul de plecare. Vezi dintr-o privire cât ai încasat, cât ai cheltuit, ce profit ai, cât TVA ai de plată și câți bani ai disponibili. Sus stau alertele: facturi netrimise în Spațiul Privat Virtual, termene care se apropie, furnizori de plătit. Iar sub ele, butoanele „Ce vrei să faci?”, pentru lucrurile de zi cu zi.

### 08 · `s08-document` — 2:07 · voce 20 s

**Se vede:** **Documente & facturi → Adaugă document primit**: zona de încărcare, apoi „Adaugă manual" și alegerea tipului dintre cele 107.

> Primul pas al ciclului: documentele. O factură primită o tragi în aplicație ca fișier, iar furnizorul, numărul, data și sumele se completează singure. Se poate și manual: alegi tipul documentului în limbaj obișnuit, dintre o sută șapte tipuri pregătite, și completezi doar ce ai pe hârtie.

### 09 · `s09-previzualizare` — 2:27 · voce 19 s

**Se vede:** Câmpurile completate pe cameră și **previzualizarea articolului contabil**, venită de la server.

> Înainte de salvare, aplicația îți arată exact ce notă contabilă va face: ce cont se debitează, ce cont se creditează și cu ce sumă. Nu trebuie să știi formula; trebuie doar să confirmi că documentul e cel din mână. Odată salvat, documentul intră în contabilitate și apare în lista lunii.

### 10 · `s09b-controale` — 3:01 · voce 23 s

**Se vede:** Salvarea, documentul apărut în listă și panoul **„Calitatea citirii automate"**.

> Documentele citite automat trec printr-o baterie de controale înainte să fie acceptate: aritmetica, cota de TVA, data — inclusiv dacă luna e închisă —, numărul documentului, partenerul cunoscut și duplicatele. Postarea automată în contabilitate este oprită implicit: se activează doar dacă o ceri tu, și doar dacă trec toate controalele.

### 11 · `s10-emite` — 3:25 · voce 14 s

**Se vede:** **Emite factură**: formularul, PDF-ul pentru client și e-Factura pentru SPV.

> Tot de aici emiți și facturile către clienți. Primești PDF-ul pentru client și fișierul e-Factura pentru ANAF, cu numărul în serie continuă. Trimiterea în Spațiul Privat Virtual și recipisa rămân în aplicație.

### 12 · `s11-bani` — 3:39 · voce 17 s

**Se vede:** **Bani**: Încasări & plăți, apoi „Verifică extrasul bancar".

> Al doilea pas: banii. Încasările și plățile prin bancă și casă, cu soldurile la zi. Extrasul bancar se importă și se potrivește singur cu facturile tale, iar ce nu se potrivește rămâne evidențiat. Acolo te uiți, nu în toată luna.

### 13 · `s12-stocuri` — 3:57 · voce 17 s

**Se vede:** **Stocuri → Ce am pe stoc**: stocul pe gestiuni, mișcările, înregistrarea unei mișcări.

> Dacă firma ține marfă, stocurile se descarcă singure la vânzare, la cost mediu ponderat sau FIFO. Ai recepții, consumuri, transferuri între gestiuni, inventar cu proces-verbal și documentele numerotate: nir, bon de consum, aviz.

### 14 · `s13-salarii` — 4:14 · voce 19 s

**Se vede:** **Salarii → Statul de plată**: tabelul de calcul și sumarul; apoi pagina **Angajați**.

> Salariile: statul de plată al lunii, cu brut, contribuții, impozit și net, calculate cu cotele în vigoare. Concedii medicale și de odihnă, tichete, avantaje în natură, avansuri și rețineri. De aici ies fluturașii, adeverințele și declarația 112.

### 15 · `s14-mijloace` — 4:34 · voce 15 s

**Se vede:** **Mijloace fixe**: registrul și adăugarea; apoi **Leasing**.

> Mijloacele fixe și amortizarea lor lunară, calculată automat, cu amortizare fiscală separată de cea contabilă. Alături, contractele de leasing cu scadențarul lor, din care se completează singură factura de rată.

### 16 · `s15-registre` — 4:49 · voce 17 s

**Se vede:** **Registre contabile**: jurnalul, fișa contului, balanța cu mesajul de echilibru.

> Registrele obligatorii se scriu singure, din documentele tale: registrul-jurnal cu toate operațiunile, fișa fiecărui cont și balanța. Iar balanța îți spune singură dacă se închide: cele patru egalități sunt verificate de fiecare dată.

### 17 · `s16-inchidere` — 5:07 · voce 28 s

**Se vede:** **Închideri → Închiderea lunii**: cockpitul cu pașii, stările și motivele concrete, derulat încet.

> Închiderea lunii e o singură listă de pași, în ordine: documentele complete, extrasul bancar punctat, TVA-ul regularizat, declarațiile validate și depuse, aprobarea și blocarea perioadei. Starea fiecărui pas se calculează din date, nu se bifează de mână: o bifă ar rămâne adevărată și după ce datele se schimbă. Iar dacă ceva lipsește, îți spune exact ce anume, și te duce în ecranul care rezolvă.

### 18 · `s17-tva` — 5:35 · voce 12 s

**Se vede:** **Taxe & declarații → TVA de plată**: decontul defalcat pe cote.

> Din luna închisă iese decontul de TVA, defalcat pe cote, cu jurnalul de vânzări și cel de cumpărări în spate. Se poate reconcilia și cu decontul precompletat pe care îl trimite ANAF.

### 19 · `s18-declaratii` — 5:48 · voce 30 s

**Se vede:** **Declarații ANAF** (lista lunii + registrul depunerilor), **SAF-T (D406)** și **Mesaje din SPV**.

> Declarațiile lunii, cu termenele lor: 300, 394, 112. Descarci fișierul, iar registrul depunerilor ține minte ce ai generat, ce ai depus și cu ce număr de recipisă. SAF-T, adică declarația 406, are pagina ei, fiindcă e cea mai mare: toată contabilitatea lunii într-un singur fișier. Iar mesajele din Spațiul Privat Virtual, adică ce îți trimite ANAF ție, stau alături.

### 20 · `s19-rapoarte` — 6:18 · voce 20 s

**Se vede:** **Rapoarte & analize**: situațiile financiare, anexele (F30, F40, note), scadențarul.

> La final citești rapoartele: contul de profit și pierdere și bilanțul, în structura oficială, plus anexele de depus - fluxurile de trezorerie, modificările capitalurilor și notele explicative. Tot aici sunt bugetul față de realizat, scadențarul pe vechimi și arhiva lunii, dosarul gata de predat.

### 21 · `s20-setari` — 6:39 · voce 32 s

**Se vede:** **Setări**, pagină cu pagină: Firma mea · Contul meu · Cine are acces · Date & copii · Conexiuni · Contabo pe calculatorul tău · Video de prezentare.

> În Setări stă tot ce se configurează o dată și se atinge rar. Datele firmei și profilul fiscal. Contul tău, cu parolă și sesiuni. Cine are acces: colaboratori, contabil, drepturi pe fiecare. Datele și copiile de siguranță, cu backup zilnic automat. Conexiunile: Spațiul Privat Virtual, citirea automată a documentelor, serverul de e-mail. Tot de aici descarci aplicația pentru calculatorul tău, care merge și fără internet, și filmul acesta de prezentare.

### 22 · `s21-incredere` — 7:11 · voce 29 s

**Se vede:** Pagina de backup și copii de siguranță, apoi cartonul „Validat cu validatorul publicat de ANAF".

> Și, la final, de ce poți avea încredere. Înainte ca o versiune să ajungă la tine, declarațiile generate trec prin validatorul publicat de ANAF, iar peste patru mii șase sute de verificări automate rulează la fiecare modificare. Dacă validarea nu poate rula, versiunea nu se publică: „n-am putut verifica” nu înseamnă „e bine”. Datele au backup zilnic, cu o copie în afara serverului și cu exerciții de restaurare rulate periodic.

### 23 · `s22-limite` — 7:41 · voce 23 s

**Se vede:** Cartonul **„Cinstit, până la capăt"** cu cele patru limite.

> Câteva lucruri rămân, cinstit, la tine. Depunerea în Spațiul Privat Virtual o faci tu, cu certificatul tău digital. Validarea finală se face cu DUKIntegrator. Casa de marcat rămâne obligatorie separat. Aplicația calculează corect, dar răspunderea fiscală rămâne a ta, iar pentru bilanț ai nevoie de semnătura unui contabil autorizat.

### 24 · `s23-final` — 8:05 · voce 11 s

**Se vede:** Cartonul final: „30 de zile gratuit, fără card · contabo.space".

> Treizeci de zile gratuit, fără card. Datele rămân ale tale, iar după probă continui de unde ai rămas. contabo.space. Aduci documentele - Contabo face contabilitatea.

---

## 4. Ce se arată și ce NU se promite

Se filmează **și** limitele — pe o piață plină de exagerări, ele conving mai mult decât încă cinci
funcții (și taie comentariile „dar depune singură?"). Într-un cartuș de 6 secunde, cu voce:

> „Depunerea în SPV o faci tu, cu certificatul tău digital. Validarea finală se face cu
> DUKIntegrator. Casa de marcat rămâne obligatorie separat. Aplicația calculează; răspunderea
> fiscală rămâne a ta."

**Nu se spune și nu se sugerează:** că depune singură la ANAF, că înlocuiește contabilul, că
garantează corectitudinea fiscală, că e „aprobată de ANAF" (validatorul ANAF *verifică* fișierele —
nu certifică aplicația).

---

## 5. Variante scurte

### 5.1 60 de secunde (feed social)

| Timp | Imagine | Voce |
|---|---|---|
| 0–6 s | Teanc de facturi → tabloul de bord | „Câți bani a făcut firma ta luna asta?" |
| 6–20 s | Se trage PDF-ul, câmpurile se completează | „Tragi factura. Furnizorul, baza și TVA-ul se completează singure." |
| 20–32 s | Cockpitul închiderii lunii | „La final de lună, o singură listă de pași — cu starea calculată din date." |
| 32–45 s | D300 → registrul depunerilor | „D300, D394, D112, SAF-T — generate din ce ai înregistrat." |
| 45–54 s | Suita verde + poarta fiscală | „Validate cu validatorul publicat de ANAF, înainte să ajungă la tine." |
| 54–60 s | Card final | „Treizeci de zile gratuit, fără card. contabo.space" |

### 5.2 30 de secunde (reclamă)

Scenele 2 (documentul) + 7 (închiderea) + card final. O idee: *munca mecanică dispare, controlul
rămâne*.

### 5.3 15 secunde (teaser, fără sunet)

Doar imagine + titraj: `Tragi factura` → `Conturile se pun singure` → `Declarațiile, gata` →
`contabo.space`. Se montează pe capturile deja existente din `marketing/capturi/`.

---

## 6. Listă de plane de rezervă (B-roll)

De filmat oricum, chiar dacă nu intră în montajul final — acoperă tăieturile și variantele:

1. Turul ghidat al meniului (butonul 🧭 **Tur meniu**) — arată singur structura pe grupuri.
2. Căutarea globală (Ctrl+K): se scrie un nume de partener și se sare direct în ecranul lui.
3. Dicționarul contabil (butonul ❓ **Dicționar**) — pentru publicul de nespecialiști.
4. Comutarea Simplu/Expert, cu meniul care se simplifică vizibil.
5. Tema întunecată (🌙) — 3 secunde, doar ca semnal de produs îngrijit.
6. Vizualizatorul de documente: se apasă un PDF din listă și se deschide **în aplicație**.
7. Scadențarul clienți & furnizori, pe vechimi.
8. **⚙️ Setări → 💻 Contabo pe calculatorul tău** — pachetul pentru rulare locală.
9. Ecranul de pe telefon (bara de jos + panoul „Mai mult"), 5 secunde — dovada că merge pe mobil.
10. Jurnalul de audit, derulat scurt — proba de control intern.

---

## 7. Post-producție

- **Subtitrare arsă**, română, la fiecare replică. Majoritatea vizionărilor sunt fără sunet.
- **Muzică** discretă, fără percuție agresivă; se coboară cu 12 dB sub voce, tăcere completă în
  scena 7 (închiderea) ca să se audă doar vocea.
- **Titraje**: maximum 6 cuvinte, sus-stânga, aceeași familie de font cu aplicația.
- **Evidențierea clicurilor**: puls discret, nu animații de cursor mari.
- **Culori**: nu se ajustează saturația ecranelor — culorile din aplicație au înțeles (verde =
  bine, roșu = de rezolvat); o corecție „mai vie" ar minți despre stări.
- **Export**: 1080p H.264 pentru site și YouTube; variantă 1:1 și 9:16 pentru feed, cu titrajele
  repoziționate (nu doar decupate).
- **Miniatură**: cadrul cu cockpitul închiderii lunii + textul `Închiderea lunii, pas cu pas`.

---

## 8. Filmul, deja înregistrat — cu voce

Scenariul nu e doar pe hârtie: **filmul există**, produs automat și reproductibil.
`scripts/video-prezentare.mjs` conduce aplicația prin cele 24 de scene și înregistrează ecranul
(Playwright înregistrează nativ, fără ffmpeg pe gazdă), iar `scripts/video-montaj.mjs` așază vocea
peste imagine și scoate mp4-ul. Rezultat: **8:20 la 1280×720, cu narațiune în română**.

**Vocea** e sintetizată local cu [piper](https://github.com/rhasspy/piper) și vocea românească
`ro_RO-mihai-medium` — nu pleacă niciun text la vreun serviciu extern. Textul rostit stă în
`scripts/naratiune-video.json`; din el se generează fișierele audio, iar durata fiecăruia
**comandă durata scenei**: filmarea execută acțiunile, apoi așteaptă restul vocii. Așa imaginea nu
fuge înaintea textului, fără să potrivim nimic de mână.

**Sincronizarea** nu e o presupunere: filmarea scrie `timeline.json` cu offsetul REAL al fiecărei
scene, iar montajul întârzie fiecare fișier audio exact cu acel offset (`adelay` + `amix`).
Peste el se adaugă un `OFFSET` global de ~1,5 s, fiindcă între începutul unei scene și ecranul ei
trec câteva sute de milisecunde de navigare — fără el, vocea descrie un ecran care încă nu se vede.

**Ce mai rămâne de făcut de un editor:** subtitrarea arsă (majoritatea vizionărilor sunt fără
sunet), muzica discretă și tăieturile fine de ritm. Vocea sintetică e inteligibilă și consecventă,
dar o voce umană rămâne mai bună pentru varianta de reclamă.

**Cum se verifică un film fără să te uiți la el opt minute:** montajul scoate un **contact** —
câte un cadru din fiecare scenă, în grilă. Se compară cu lista din capitolul 3: dacă tabloul din
dreptul unei replici arată alt ecran, sincronizarea sau ordinea sunt greșite. Așa s-au prins șase
eșecuri **tăcute**, toate raportând „reușit" la fiecare pas:

1. **CSP-ul aplicației** (`style-src 'self'`, fără `unsafe-inline`) bloca stilul injectat pentru
   cartoane și cursor — prima înregistrare a ieșit fără ele, fără nicio eroare.
2. **Cartonul de titlu rămâne în DOM între scene** (transparent) și, fără `pointer-events: none`,
   înghițea clicurile: formularul nu se mai deschidea.
3. **Clicul pe a doua intrare a unui grup deschis** pică cu „Element is not visible" după ce pagina
   e derulată, deși omul o vede; navigarea se face prin `goTab`, cu cursorul plimbat pe intrare.
4. **`waitForSelector('#registerOverlay.hidden')`** cu starea implicită „visible" nu se poate
   împlini niciodată — înscrierea reușea, iar filmarea raporta eșec.
5. **CUI-ul inventat** pică la cifra de control, iar serverul răspunde 400: contul nu se crea, dar
   filmarea mergea mai departe peste formularul rămas pe ecran.
6. **„Ieși" cheamă `location.reload()`**, care se ciocnea cu navigarea scriptului și lăsa sesiunea
   în aer — de două ori filmul a rămas pe contul de probă.

---

## 9. Verificări înainte de publicare

- [ ] Toate cifrele rostite s-au reverificat în ziua montajului: numărul de verificări din suită,
      tipurile de operațiuni, prețurile (99 lei Start, 199 lei Pro, probă 30 de zile fără card).
- [ ] Niciun CUI, nume sau adresă reală de client în cadru; doar firma-exemplu din seed.
- [ ] Nicio secvență filmată pe demoul public (datele lui se schimbă zilnic, de la vizitatori).
- [ ] Cartușul de limite (capitolul 4) e prezent în varianta principală — în filmul înregistrat e
      scena `s22-limite`, rostită integral.
- [ ] Contactul de imagini a fost comparat cu lista de scene din capitolul 3.
- [ ] Fiecare ecran arătat există în versiunea publicată — se revede filmul cu aplicația alături.
- [ ] Adresa din cardul final e lizibilă și corectă, iar butonul de probă chiar duce la înscriere.
- [ ] Subtitrarea a fost citită de cineva care nu a lucrat la film (greșelile proprii nu se văd).
