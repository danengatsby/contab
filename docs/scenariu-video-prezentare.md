# Scenariu — video de prezentare Contabo

Scenariu de filmare (screencast cu voce), gata de dat unui editor video. **Fiecare afirmație din
voice-over e verificabilă în aplicație** — dacă schimbi ceva aici, verifică întâi în produs, ca la
`PREZENTARE.md`: o promisiune ratată la ANAF costă mai mult decât o vizionare câștigată.

- **Public:** patroni de firme mici (nu știu contabilitate) + contabili care caută clienți.
- **Obiectiv:** două idei, în ordinea asta — *(1) patronul își angajează contabilul chiar din
  aplicație, dintre cei înscriși, iar contabilul acceptă și abia atunci vede datele; (2) patronul
  aduce documentele, aplicația face contabilitatea, iar ordinea în care lucrezi e ciclul contabil.*
- **Ton:** calm, concret, fără superlative. Se arată ecrane reale, nu ilustrații.
- **Durata:** varianta principală **11:27**, cu voce în română (39 de scene); variante scurte de
  60 s, 30 s și 15 s (capitolul 5).
- **Format:** 1280×720, 25 fps, voce română. Subtitrarea arsă rămâne de adăugat — mulți se uită
  fără sunet.
- **Textul rostit** stă în `scripts/naratiune-video.json` — o singură sursă, din care se generează
  și vocea, și capitolul 3 de mai jos. Dacă schimbi o replică, schimb-o acolo, apoi rulează
  `node scripts/genereaza-scenariu.js`. Durata fiecărei replici e măsurată, nu estimată, și stă în
  `scripts/naratiune-durate.json` (se rescrie la regenerarea vocii).

---

## 1. Pregătirea filmării

### 1.1 Pe ce instanță se filmează

**NU pe contul demo public.** Demoul de pe contabo.space e scriibil de oricine și se resetează
zilnic — la prima încercare de capturi de marketing, tabloul de bord arăta sold negativ, 10 termene
depășite și facturi netrimise. Se filmează pe o **instanță izolată**, cu exemplul oficial din ghid:

```bash
npm run seed                      # firma-exemplu (S.C. EXEMPLU PROD S.R.L.), date pe 2026-06
node scripts/video-decor.js       # actorii: doi patroni, un contabil, cererile dintre ei
```

**`video-decor.js` nu e opțional.** Scenele 5–9 arată angajarea unui contabil, iar seed-ul singur
n-are pe cine angaja: face o firmă și atât. Decorul adaugă un patron cu **două** firme, un al
doilea patron cu firma lui, și o contabilă disponibilă — cu o cerere deja acceptată de la fiecare
patron și **una în așteptare**, ca acceptarea să se poată filma pe viu. Se rulează din nou înaintea
fiecărei filmări: scena 7 consumă cererea în așteptare.

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

Filmul are **două părți**. Prima (scenele 3–9) e despre **cine lucrează pe firmă**: patronul își
alege contabilul dintre cei înscriși în aplicație și îi trimite o cerere pentru o firmă anume;
contabilul acceptă, și abia atunci primește acces. Se filmează pe **două conturi diferite**, fiindcă
altfel ar fi o afirmație, nu o dovadă. Tot acolo se arată că un contabil poate fi angajat de mai
mulți patroni și poate ține mai multe firme ale aceluiași patron — fiecare cu cererea ei.

A doua parte e **ciclul contabil**, fiindcă chiar așa e organizat meniul, de sus în jos:

```
Documente & facturi → Bani → Stocuri · Salarii · Mijloace fixe →
Registre contabile → Închideri → Taxe & declarații → Rapoarte & analize
```

Filmul merge exact pe acest drum. Spectatorul învață ordinea o dată și o recunoaște în meniu.

---

## 3. Scenariul, scenă cu scenă

<!-- SCENE:START — generat de scripts/genereaza-scenariu.js, nu edita manual -->

**39 de scene**, în ordinea ciclului contabil — cu blocul de deschidere despre
**angajarea contabilului**, fiindcă de acolo începe orice firmă. Fiecare scenă ține **exact cât vocea ei**:
acțiunile se execută, apoi filmarea așteaptă restul — de aceea imaginea nu fuge înaintea textului.

Durata totală a vocii: **11:30**.

### 01 · `s01-prezentare` — 0:01 · voce 16 s

**Se vede:** Pagina publică `prezentare.html`: antetul, cele trei cifre, „Nu trebuie să știi formula contabilă".

> Contabo. Contabilitate românească completă, într-un singur loc. Patronul aduce documentele, aplicația face contabilitatea, iar contabilul o verifică și o semnează. Hai să vedem tot drumul, de la primul clic până la declarația depusă.

### 02 · `s02-preturi` — 0:17 · voce 21 s

**Se vede:** Secțiunea de prețuri de pe aceeași pagină (Probă / Start / Pro), apoi „Ce face aplicația — și ce rămâne la tine".

> Întâi prețurile, ca să știi de la început. Ai treizeci de zile de probă, fără card bancar. Apoi, nouăzeci și nouă de lei pe lună pentru planul Start și o sută nouăzeci și nouă pentru Pro. Toate funcțiile sunt incluse în fiecare plan: stocurile, salariile, declarațiile. Planurile se deosebesc prin preț, nu prin funcții.

### 03 · `s03-cont` — 0:38 · voce 13 s

**Se vede:** Ecranul de autentificare → „🚀 Testează gratuit" → formularul de înscriere, cu **alegerea rolului** apăsată pe cameră: întâi „contabil", apoi „patron".

> Contul se face în două minute. Primul lucru pe care îl alegi este cine ești: patron sau contabil. De alegerea asta atârnă tot restul, fiindcă cei doi lucrează împreună, dar nu fac același lucru.

### 04 · `s04-doua-roluri` — 0:51 · voce 21 s

**Se vede:** Carton pe ecran plin: „Patronul aduce. Contabilul răspunde."

> Patronul are firma și aduce documentele. Contabilul verifică înregistrările, semnează bilanțul și răspunde profesional pentru ele. Aplicația face munca dintre ei, dar nu ține locul niciunuia. De aceea, ca patron, primul lucru pe care îl faci după ce ți-ai creat firma nu e o factură, ci angajarea unui contabil.

### 05 · `s05-lista-contabili` — 1:12 · voce 15 s

**Se vede:** Contul **patronului** → Setări → 👥 Cine are acces → cardul „🧮 Contabili și cereri de servicii", cu Maria Ionescu în listă: oraș, telefon, specializare.

> Contabilii sunt chiar în aplicație. Un contabil care vrea să primească clienți bifează, în contul lui, „Apar în lista de contabili”, și de atunci e vizibil aici, cu numele și datele lui de contact. Patronul deschide lista și alege.

### 06 · `s06-angajare` — 1:27 · voce 17 s

**Se vede:** Selectorul de firmă din rândul contabilei (patronul alege PENTRU CARE firmă îl vrea), apoi tabelul „Cereri trimise de tine": una acceptată, una în așteptare, cu butonul „Retrage".

> Angajarea e o cerere trimisă pentru o firmă anume. Alegi contabilul, alegi firma și trimiți. Numai proprietarul firmei poate face asta: un colaborator, oricâte drepturi ar avea, nu poate angaja un contabil în locul patronului. Cererea pleacă și rămâne în așteptare.

### 07 · `s07-acceptare` — 1:44 · voce 15 s

**Se vede:** Contul **contabilei** → aceeași pagină, secțiunea „Cereri primite de la patroni" → clic pe **Accept**, pe cameră.

> Contabilul își vede cererile primite și decide. Acceptă, și abia din acel moment primește acces la datele firmei. Refuză, și nu vede nimic. Accesul nu se ia, se dă — iar patronul îl poate retrage oricând, tot de aici.

### 08 · `s08-multi-firma` — 1:59 · voce 16 s

**Se vede:** Selectorul de firme al contabilei, deschis: firme de la **doi patroni diferiți**, plus a doua firmă a primului patron, tocmai acceptată.

> Un contabil nu ține o singură firmă. Poate fi angajat de mai mulți patroni, și poate ține mai multe firme ale aceluiași patron — fiecare cu cererea ei, acceptată separat. Fiecare firmă rămâne izolată: datele uneia nu se văd din alta.

### 09 · `s09-portofoliu` — 2:15 · voce 17 s

**Se vede:** Tabul 🗂 **Portofoliu** — tabelul de conformitate: o linie pe firmă, o coloană pe lună.

> Așa se naște portofoliul contabilului. Toate firmele pe care le ține, într-un singur tabel de conformitate: pe fiecare lună și fiecare firmă, ce s-a depus și ce mai lipsește. De aici intră în oricare dintre ele, fără să se încurce între conturi.

### 10 · `s10-primaintrare` — 2:32 · voce 22 s

**Se vede:** Înapoi pe contul patronului, luna de lucru pe iunie 2026. Grupurile din meniu deschise pe rând: Documente, Bani, Taxe, Rapoarte.

> Să intrăm acum pe o firmă care lucrează de câteva luni. La prima intrare ești întâmpinat cu trei pași simpli și cu un tur al meniului. Meniul urmează ordinea în care se lucrează, adică ciclul contabil: documentele, banii, ce mișcă în fiecare lună, registrele, închiderea lunii, declarațiile și, la final, rapoartele.

### 11 · `s11-ghid` — 2:54 · voce 19 s

**Se vede:** Tabul **Ghid**, derulat, apoi **❓ Dicționar** deschis peste el.

> Dacă nu ai mai ținut contabilitate, începi din Ghid. E scris pe înțelesul oricui și te duce pas cu pas: ce documente aduni, cum le înregistrezi, ce verifici la final de lună și ce depui la ANAF. Lângă el stă dicționarul, cu termenii contabili explicați în cuvinte obișnuite.

### 12 · `s12-acasa` — 3:12 · voce 20 s

**Se vede:** **Acasă**: „⏰ De făcut acum" cu restanțele și termenele, apoi „Situația firmei — pe scurt".

> Acasă e punctul de plecare. Sus stă „De făcut acum”: restanțele și termenele apropiate, fiecare cu butonul care le rezolvă. Sub ele, situația firmei pe scurt — bani disponibili, de încasat, de plătit, obligații la stat. Iar dacă un cont de bani e în minus, ți-o spune, nu o ascunde în total.

### 13 · `s13-document` — 3:33 · voce 20 s

**Se vede:** Tabul **➕ Adaugă document primit**: zona de încărcare, apoi formularul deschis cu „✏️ Adaugă manual".

> Primul pas al ciclului: documentele. O factură primită o tragi în aplicație ca fișier, iar furnizorul, numărul, data și sumele se completează singure. Se poate și manual: alegi tipul documentului în limbaj obișnuit, dintre o sută șapte tipuri pregătite, și completezi doar ce ai pe hârtie.

### 14 · `s14-preview-pdf` — 3:53 · voce 19 s

**Se vede:** Vizualizatorul din aplicație, peste ecran: registrul documentelor lunii, ca PDF.

> Documentele nu te trimit în altă parte. Orice PDF din aplicație se deschide aici, peste ecran: factura pe care tocmai ai emis-o, un registru, o situație. Îl citești, îl răsfoiești și abia apoi îl descarci — e chiar fișierul care pleacă mai departe, la client, la bancă sau la contabil.

### 15 · `s15-previzualizare` — 4:12 · voce 15 s

**Se vede:** Formularul de factură de cumpărare completat pe cameră, cu previzualizarea notei contabile (debit / credit / sumă) care se recalculează.

> Înainte de salvare, aplicația îți arată exact ce notă contabilă va face: ce cont se debitează, ce cont se creditează și cu ce sumă. Nu trebuie să știi formula; trebuie doar să confirmi că documentul e cel din mână.

### 16 · `s16-controale` — 4:26 · voce 23 s

**Se vede:** Carton cu cele opt controale, apoi lista documentelor primite cu verdictul fiecăruia.

> Documentele citite automat trec printr-o baterie de controale înainte să fie acceptate: aritmetica, cota de TVA, data — inclusiv dacă luna e închisă —, numărul documentului, partenerul cunoscut și duplicatele. Postarea automată în contabilitate e oprită implicit: se activează doar dacă o ceri tu, și doar dacă trec toate controalele.

### 17 · `s17-emite` — 4:49 · voce 17 s

**Se vede:** Tabul **🧾 Emite factură**: cele trei alegeri în limbaj obișnuit, apoi formularul deschis.

> Tot de aici emiți facturile către clienți. Spui în cuvinte simple ce vinzi — marfă, produs făcut de tine, sau serviciu — iar aplicația alege tipul contabil potrivit. Primești PDF-ul pentru client și fișierul e-Factura pentru ANAF, cu numărul în serie continuă.

### 18 · `s18-preview-efactura` — 5:06 · voce 17 s

**Se vede:** Vizualizatorul: fișierul **e-Factura (XML UBL)** randat ca factură lizibilă — furnizor, client, linii, cote, total.

> Și e-Factura se vede în aplicație. Fișierul trimis la ANAF e un XML, greu de citit pentru un om — așa că aplicația îl arată ca pe o factură normală: furnizor, client, linii, cote, total. Ce pleacă la ANAF și ce vezi tu sunt același document.

### 19 · `s19-bani` — 5:24 · voce 19 s

**Se vede:** **Încasări & plăți**: registrul lunii cu butoanele de înregistrare, apoi **Verifică extrasul bancar**.

> Al doilea pas: banii. Încasările și plățile prin bancă și casă, cu soldurile la zi, și butoanele cu care le înregistrezi direct de aici. Extrasul bancar se importă și se potrivește singur cu facturile tale, iar ce nu se potrivește rămâne evidențiat. Acolo te uiți, nu în toată luna.

### 20 · `s20-stocuri` — 5:43 · voce 17 s

**Se vede:** Tabul **Ce am pe stoc**: stocul pe gestiuni și mișcările lunii.

> Dacă firma ține marfă, stocurile se descarcă singure la vânzare, la cost mediu ponderat sau FIFO. Ai recepții, consumuri, transferuri între gestiuni, inventar cu proces-verbal și documentele numerotate: nir, bon de consum, aviz.

### 21 · `s21-salarii` — 5:60 · voce 19 s

**Se vede:** **Statul de plată**: brut, contribuții, impozit, net, pe fiecare angajat.

> Salariile: statul de plată al lunii, cu brut, contribuții, impozit și net, calculate cu cotele în vigoare. Concedii medicale și de odihnă, tichete, avantaje în natură, avansuri și rețineri. De aici ies fluturașii, adeverințele și declarația 112.

### 22 · `s22-mijloace` — 6:19 · voce 15 s

**Se vede:** **Mijloace fixe** cu amortizarea lunară, apoi **Leasing** cu scadențarul.

> Mijloacele fixe și amortizarea lor lunară, calculată automat, cu amortizare fiscală separată de cea contabilă. Alături, contractele de leasing cu scadențarul lor, din care se completează singură factura de rată.

### 23 · `s23-registre` — 6:34 · voce 17 s

**Se vede:** **Registrul-jurnal**, apoi **Balanța** cu verdictul celor patru egalități.

> Registrele obligatorii se scriu singure, din documentele tale: registrul-jurnal cu toate operațiunile, fișa fiecărui cont și balanța. Iar balanța îți spune singură dacă se închide: cele patru egalități sunt verificate de fiecare dată.

### 24 · `s24-preview-csv` — 6:51 · voce 14 s

**Se vede:** Vizualizatorul: balanța ca **fișier CSV**, în text simplu, coloană cu coloană.

> Orice registru se poate scoate și ca fișier, pentru contabil sau pentru control. Îl deschizi tot aici, ca text simplu, înainte să-l descarci — vezi exact ce conține, coloană cu coloană, fără să-l cari într-un alt program.

### 25 · `s25-inchidere` — 7:05 · voce 22 s

**Se vede:** **Închiderea lunii**: lista de pași cu starea fiecăruia, derivată din date.

> Închiderea lunii e o singură listă de pași, în ordine: documentele complete, extrasul bancar punctat, TVA-ul regularizat, declarațiile validate și depuse, aprobarea și blocarea perioadei. Starea fiecărui pas se calculează din date, nu se bifează de mână: o bifă ar rămâne adevărată și după ce datele se schimbă.

### 26 · `s26-inchidere-an` — 7:27 · voce 17 s

**Se vede:** **Închiderea anului**: cei trei pași anuali.

> Peste închiderea lunii stă închiderea anului, cu pașii care se fac o singură dată: calculul impozitului pe profit, închiderea conturilor de venituri și cheltuieli, și repartizarea rezultatului. Aceeași listă în ordine, cu fiecare pas explicat.

### 27 · `s27-regfiscal` — 7:44 · voce 17 s

**Se vede:** **Registrul de evidență fiscală**: drumul de la rezultatul contabil la cel fiscal.

> Impozitul pe profit are registrul lui de evidență fiscală: pornește de la rezultatul contabil și arată, rând cu rând, drumul până la cel fiscal — ce cheltuieli nu sunt deductibile și ce venituri nu se impozitează. Din el iese declarația 101.

### 28 · `s28-tva` — 8:01 · voce 14 s

**Se vede:** **TVA de plată**: decontul perioadei, defalcarea pe cote, jurnalele.

> Din luna închisă iese decontul de TVA, defalcat pe cote, cu jurnalul de vânzări și cel de cumpărări în spate. Fiecare cifră își spune perioada, ca să nu confunzi decontul unei luni cu soldul cumulat pe tot anul.

### 29 · `s29-etva` — 8:15 · voce 14 s

**Se vede:** Cardul „Decont precompletat e-TVA — reconciliere".

> Din 2025, ANAF trimite un decont precompletat. Aplicația îl aduce și îl compară rând cu rând cu decontul tău, ca să vezi exact unde diferă și de ce — înainte de depunere, nu după notificare.

### 30 · `s30-declaratii` — 8:29 · voce 20 s

**Se vede:** **Declarații ANAF**: „📮 De depus — luna…" cu termene, stare și fișierul pe fiecare rând; catalogul complet, pliat, dedesubt.

> Ecranul declarațiilor începe cu ce ai de depus luna asta: fiecare declarație cu termenul ei, starea ei și fișierul de descărcat chiar pe rând. Registrul depunerilor ține minte ce ai generat, ce ai depus și cu ce număr de recipisă. Lista completă a livrabilelor stă dedesubt, pentru contabil.

### 31 · `s31-preview-xml` — 8:49 · voce 13 s

**Se vede:** Vizualizatorul: **XML-ul D300**, aranjat pe rânduri, cu etichetele lui.

> Și declarația se vede înainte să pleace. XML-ul pentru ANAF se deschide aici, aranjat pe rânduri, cu etichetele lui — nu ca un șir lipit. Contabilul poate citi ce se depune, fără niciun program în plus.

### 32 · `s32-saft` — 9:02 · voce 15 s

**Se vede:** Tabul **SAF-T (D406)**: ce pleacă în fișier.

> Tot de aici iese și SAF-T, declarația 406: fișierul standard de audit cerut de ANAF, cu conturile, partenerii și mișcările perioadei. Se generează din aceleași date ca restul, nu dintr-o evidență paralelă.

### 33 · `s33-rapoarte` — 9:17 · voce 18 s

**Se vede:** **Situații financiare** (bilanț, cont de profit și pierdere), apoi **Scadențarul** pe vechimi.

> La final citești rapoartele: contul de profit și pierdere și bilanțul, în structura oficială, plus anexele de depus — fluxurile de trezorerie, modificările capitalurilor și notele explicative. Tot aici sunt bugetul față de realizat și scadențarul pe vechimi.

### 34 · `s34-arhiva` — 9:35 · voce 15 s

**Se vede:** **Arhivă documente**: dosarul lunii.

> Tot ce intră în aplicație se așază singur în arhivă, pe luni. Dosarul lunii adună la un loc documentele, notele contabile și declarațiile ei — de dat mai departe la un control, sau contabilului, fără să cauți prin e-mailuri.

### 35 · `s35-setari` — 9:50 · voce 25 s

**Se vede:** Setările, parcurse: Firma mea, Contul meu, Cine are acces, Date & copii de siguranță, Conexiuni.

> În Setări stă tot ce se configurează o dată și se atinge rar. Datele firmei și profilul fiscal. Contul tău, cu parolă și sesiuni. Cine are acces: contabilul angajat, colaboratorii, drepturile fiecăruia. Copiile de siguranță, cu backup zilnic automat. Conexiunile: Spațiul Privat Virtual, citirea automată a documentelor, serverul de e-mail.

### 36 · `s36-audit` — 10:15 · voce 16 s

**Se vede:** **Jurnal de audit**: cine a făcut ce și când.

> Și fiecare operațiune lasă urmă. Jurnalul de audit arată cine a făcut ce și când, cu export propriu. E util la un control, dar mai ales când patronul și contabilul lucrează pe aceleași date și trebuie să se știe cine a schimbat o sumă.

### 37 · `s37-incredere` — 10:30 · voce 24 s

**Se vede:** Pagina de backup, apoi cartonul „Validat cu validatorul publicat de ANAF".

> De ce poți avea încredere. Înainte ca o versiune să ajungă la tine, declarațiile generate trec prin validatorul publicat de ANAF, iar peste cinci mii două sute de verificări automate rulează la fiecare modificare. Dacă validarea nu poate rula, versiunea nu se publică: „n-am putut verifica” nu înseamnă „e bine”. Datele au backup zilnic, cu o copie în afara serverului.

### 38 · `s38-limite` — 10:55 · voce 26 s

**Se vede:** Carton pe ecran plin: ce rămâne la patron și la contabil.

> Câteva lucruri rămân, cinstit, la voi. Depunerea în Spațiul Privat Virtual se face cu certificatul digital al firmei. Validarea finală se face cu DUKIntegrator. Casa de marcat rămâne obligatorie separat. Aplicația calculează corect, dar răspunderea fiscală rămâne a firmei, iar bilanțul cere semnătura unui contabil autorizat — de aceea am început cu angajarea lui.

### 39 · `s39-final` — 11:21 · voce 10 s

**Se vede:** Carton final: „30 de zile gratuit, fără card · contabo.space".

> Treizeci de zile gratuit, fără card. Patronul aduce documentele, contabilul le verifică și le semnează, Contabo face restul. contabo.space.

<!-- SCENE:STOP -->

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
`scripts/video-prezentare.mjs` conduce aplicația prin cele 32 de scene și înregistrează ecranul
(Playwright înregistrează nativ, fără ffmpeg pe gazdă), iar `scripts/video-montaj.mjs` așază vocea
peste imagine și scoate mp4-ul. Rezultat: **10:08 la 1280×720, cu narațiune în română**.

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
