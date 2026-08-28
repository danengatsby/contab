# Scenariu — video de prezentare Contabo

Scenariu de filmare (screencast cu voce), gata de dat unui editor video. **Fiecare afirmație din
voice-over e verificabilă în aplicație** — dacă schimbi ceva aici, verifică întâi în produs, ca la
`PREZENTARE.md`: o promisiune ratată la ANAF costă mai mult decât o vizionare câștigată.

- **Public:** patroni de firme mici (nu știu contabilitate) + contabili care caută clienți.
- **Obiectiv:** două idei, în ordinea asta — *(1) patronul își angajează contabilul chiar din
  aplicație, dintre cei înscriși, iar contabilul acceptă și abia atunci vede datele; (2) patronul
  aduce documentele, aplicația face contabilitatea, iar ordinea în care lucrezi e ciclul contabil.*
- **Ton:** calm, concret, fără superlative. Se arată ecrane reale, nu ilustrații.
- **Durata:** vezi capitolul 3 — se scrie SINGURĂ acolo, din duratele măsurate ale vocii. Nu o
  repeta aici: antetul spunea „11:27, 39 de scene" pentru un film ajuns la 22:10 și 67 de scene,
  fiindcă nimic nu-l confrunta cu realitatea. Variante scurte de 60 s, 30 s și 15 s: capitolul 5.
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

Capturile statice folosesc acum launcherul reproductibil `npm run capturi-marketing`, care creează
și distruge singur baza și serverul temporare. Filmarea păstrează decorul extins de mai sus; capcanele
de operare comune, toate întâlnite pe viu, sunt:

- luna de lucru e **globală**: exemplul are datele pe iunie, deci se mută luna din bara de sus;
- prima autentificare pe o bază proaspătă cere **schimbarea parolei** — se face înainte de filmare;
- actorii care dețin sau aprobă firme sunt conturi privilegiate și cer **2FA**; decorul video îl
  activează cu un secret strict fictiv, iar scenariul introduce codul curent la autentificare;
- selectorul de firmă e `#firmaSelect`, iar firma activă după creări e **ultima** creată (goală):
  se comută explicit pe firma cu date, altfel decontul iese cu toate zerourile;
- marcarea unei declarații ca „depusă" actualizează registrul și recipisa, dar **nu blochează
  perioada**; blocarea și banda de lună închisă apar numai la ultima acțiune din cockpit;
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

**74 de scene**, în ordinea ciclului contabil — cu blocul de deschidere despre
**angajarea contabilului**, fiindcă de acolo începe orice firmă. Fiecare scenă ține **exact cât vocea ei**:
acțiunile se execută, apoi filmarea așteaptă restul — de aceea imaginea nu fuge înaintea textului.

Durata totală a vocii: **24:22**.

### 01 · `s01-prezentare` — 0:01 · voce 26 s

**Se vede:** Pagina publică `prezentare.html`: antetul, cele trei cifre, „Nu trebuie să știi formula contabilă".

> Contabo. Contabilitate românească completă, într-un singur loc. Patronul aduce documentele, aplicația face contabilitatea, iar contabilul o verifică și o semnează. Filmul ăsta merge pe ciclul contabil, de la deschiderea exercițiului până la bilanțul depus. Explicațiile sunt pe două niveluri: pe înțelesul patronului, iar unde e nevoie, cu detaliul profesional pentru contabil.

### 02 · `s02-preturi` — 0:27 · voce 21 s

**Se vede:** Secțiunea de prețuri de pe aceeași pagină (Probă / Start / Pro), apoi „Ce face aplicația — și ce rămâne la tine".

> Întâi prețurile, ca să știi de la început. Ai treizeci de zile de probă, fără card bancar. Apoi, fiecare firmă costă nouăzeci și nouă de lei pe lună, fie că alegi Start, fie Pro. Ambele includ toate funcțiile: Start pornește în modul Simplu pentru antreprenori, iar Pro în modul Expert pentru contabili.

### 03 · `s03-cont` — 0:48 · voce 13 s

**Se vede:** Ecranul de autentificare → „🚀 Testează gratuit" → formularul de înscriere, cu **alegerea rolului** apăsată pe cameră: întâi „contabil", apoi „patron".

> Contul se face în două minute. Primul lucru pe care îl alegi este cine ești: patron sau contabil. De alegerea asta atârnă tot restul, fiindcă cei doi lucrează împreună, dar nu fac același lucru.

### 04 · `s04-doua-roluri` — 1:01 · voce 21 s

**Se vede:** Carton pe ecran plin: „Patronul aduce. Contabilul răspunde."

> Patronul are firma și aduce documentele. Contabilul verifică înregistrările, semnează bilanțul și răspunde profesional pentru ele. Aplicația face munca dintre ei, dar nu ține locul niciunuia. De aceea, ca patron, primul lucru pe care îl faci după ce ți-ai creat firma nu e o factură, ci angajarea unui contabil.

### 05 · `s05-lista-contabili` — 1:22 · voce 14 s

**Se vede:** Contul **patronului** → Setări → 👥 Cine are acces → cardul „🧮 Contabili și cereri de servicii", cu Maria Ionescu în listă: oraș, telefon, specializare.

> Contabilii sunt chiar în aplicație. Un contabil care vrea să primească clienți bifează, în contul lui, „Apar în lista de contabili”, și de atunci e vizibil aici, cu numele și datele lui de contact. Patronul deschide lista și alege.

### 06 · `s06-angajare` — 1:36 · voce 17 s

**Se vede:** Selectorul de firmă din rândul contabilei (patronul alege PENTRU CARE firmă îl vrea), apoi tabelul „Cereri trimise de tine": una acceptată, una în așteptare, cu butonul „Retrage".

> Angajarea e o cerere trimisă pentru o firmă anume. Alegi contabilul, alegi firma și trimiți. Numai proprietarul firmei poate face asta: un colaborator, oricâte drepturi ar avea, nu poate angaja un contabil în locul patronului. Cererea pleacă și rămâne în așteptare.

### 07 · `s07-acceptare` — 1:53 · voce 16 s

**Se vede:** Contul **contabilei** → aceeași pagină, secțiunea „Cereri primite de la patroni" → clic pe **Accept**, pe cameră.

> Contabilul își vede cererile primite și decide. Acceptă, și abia din acel moment primește acces la datele firmei. Refuză, și nu vede nimic. Accesul nu se ia, se dă — iar patronul îl poate retrage oricând, tot de aici.

### 08 · `s08-multi-firma` — 2:09 · voce 16 s

**Se vede:** Selectorul de firme al contabilei, deschis: firme de la **doi patroni diferiți**, plus a doua firmă a primului patron, tocmai acceptată.

> Un contabil nu ține o singură firmă. Poate fi angajat de mai mulți patroni, și poate ține mai multe firme ale aceluiași patron — fiecare cu cererea ei, acceptată separat. Fiecare firmă rămâne izolată: datele uneia nu se văd din alta.

### 09 · `s09-portofoliu` — 2:25 · voce 15 s

**Se vede:** Tabul 🗂 **Portofoliu** — tabelul de conformitate: o linie pe firmă, o coloană pe lună.

> Contabilul are portofoliul lui: toate firmele pe care le ține, cu starea fiecăreia la zi. De aici trece dintr-o firmă în alta, fără să se dezautentifice. Pentru un contabil cu zece clienți, asta e pagina de dimineață.

### 10 · `s10-primaintrare` — 2:40 · voce 19 s

**Se vede:** Înapoi pe contul patronului, luna de lucru pe iunie 2026. Grupurile din meniu deschise pe rând: Documente, Bani, Taxe, Rapoarte.

> Acum începe ciclul contabil propriu-zis. Prima fază e deschiderea exercițiului: îți spui datele firmei, alegi regimul de impozitare și de TVA, iar de aici încolo aplicația știe ce declarații îți revin și la ce termene. Se completează o dată, la început, și se schimbă rar.

### 11 · `s11-ghid` — 2:59 · voce 16 s

**Se vede:** Tabul **Ghid**, derulat, apoi **❓ Dicționar** deschis peste el.

> Dacă nu știi de unde să începi, ghidul e în aplicație, nu într-un manual separat. Explică fiecare pas în limbaj obișnuit, cu exemplul unei firme reale care merge de la primul document până la declarația depusă. Îl poți urmări în paralel cu munca ta.

### 12 · `s12-acasa` — 3:15 · voce 17 s

**Se vede:** **Acasă**: „⏰ De făcut acum" cu restanțele și termenele, apoi „Situația firmei — pe scurt".

> Tabloul de bord e prima pagină. Îți arată banii pe conturi, ce ai de încasat și de plătit, termenele fiscale care vin și documentele care lipsesc. E gândit ca patronul să înțeleagă din trei secunde dacă firma stă bine sau nu, fără să deschidă niciun raport.

### 13 · `s12b-birou` — 3:33 · voce 22 s

**Se vede:** Interfața modernă: arborele unic din stânga, bara contextuală cu pagina/firma/perioada și ajutorul contextual deschis la cerere.

> Totul pornește dintr-un singur arbore lateral, ordonat după ciclul contabil. Bara de sus îți spune permanent în ce pagină, firmă și perioadă lucrezi, fără copii sau meniuri concurente. Textul și controalele rămân lizibile, iar explicațiile se deschid numai când ai nevoie de ele. Modul compact strânge tabelele, nu întreaga aplicație.

### 14 · `s12c-simplu` — 3:54 · voce 15 s

**Se vede:** Tabloul de bord, comutat în modul simplu și înapoi în expert — se vede cum dispar și reapar codurile de cont și intrările tehnice.

> Dacă nu ești contabil, aplicația se poate dezbrăca de partea tehnică. În modul simplu dispar codurile de cont și ecranele de specialitate din navigația unică și din conținut. Comuți înapoi oricând, iar datele rămân aceleași.

### 15 · `s10b-plan` — 4:09 · voce 36 s

**Se vede:** **Plan de conturi**: planul oficial românesc, cu locul în care se adaugă analitice proprii.

> Tot din deschiderea exercițiului fac parte două lucruri pe care le atingi o singură dată. Primul, planul de conturi: lista sertarelor în care se adună sumele firmei — clienți, furnizori, bancă, mărfuri. E cel oficial românesc, complet, și poți să îl lași exact așa, fiindcă aplicația alege singură contul potrivit la fiecare document. Îl deschizi doar dacă vrei conturi analitice proprii, de exemplu un cont separat pe fiecare client. Pentru contabil: analiticele adăugate aici sunt cele care apar apoi în balanță și în fișele de cont.

### 16 · `s10c-solduri` — 4:45 · voce 29 s

**Se vede:** Setări → Date: cardul **Solduri inițiale (preluare firmă cu istoric)**, cu importul balanței din programul vechi.

> Dacă firma nu e la primul an, nu începi de la zero. Preiei balanța de deschidere: o imporți direct din fișierul exportat de programul vechi, sau o introduci cont cu cont. Totalul pe debit trebuie să fie egal cu totalul pe credit — altfel balanța nu se închide niciodată, iar aplicația refuză preluarea. Pentru contabil: soldurile pe fiecare client și furnizor se detaliază separat, iar stocul cantitativ-valoric are preluarea lui.

### 17 · `s10d-migrare` — 5:14 · voce 21 s

**Se vede:** Ecranul „Date & copii de siguranță", cardul de migrare: fișierul urcat, coloanele recunoscute și previzualizarea dinaintea scrierii.

> Dacă vii de la alt program, nu retastezi nimic. Aduci balanța, partenerii, stocurile și mijloacele fixe dintr-un export obișnuit — XLS, CSV sau DBF — iar aplicația îți arată întâi ce a înțeles din fiecare coloană și abia apoi scrie ceva. Potrivirea coloanelor se salvează, deci a doua firmă merge de la sine.

### 18 · `s13-document` — 5:34 · voce 25 s

**Se vede:** Tabul **➕ Adaugă document primit**: zona de încărcare, apoi formularul deschis cu „✏️ Adaugă manual".

> Faza a doua: documentele justificative. Aici intră totul în contabilitate, și nimic nu intră altfel. O factură primită o tragi în aplicație ca fișier, iar furnizorul, numărul, data și sumele se completează singure. Se poate și manual: alegi tipul documentului în limbaj obișnuit, dintre peste o sută douăzeci de tipuri pregătite, și completezi doar ce ai pe hârtie.

### 19 · `s14-preview-pdf` — 5:59 · voce 16 s

**Se vede:** Vizualizatorul din aplicație, peste ecran: registrul documentelor lunii, ca PDF.

> Documentul rămâne atașat la înregistrare, nu doar cifrele din el. Îl deschizi din orice listă și vezi originalul scanat, lângă nota contabilă care a ieșit din el. La un control, asta e diferența dintre „vă trimit mâine” și „poftiți”.

### 20 · `s15-previzualizare` — 6:15 · voce 24 s

**Se vede:** Formularul de factură de cumpărare completat pe cameră, cu previzualizarea notei contabile (debit / credit / sumă) care se recalculează.

> Înainte de salvare, aplicația îți arată exact ce notă contabilă va face: ce cont se debitează, ce cont se creditează și cu ce sumă. Nu trebuie să știi formula; trebuie doar să confirmi că documentul e cel din mână. Previzualizarea vine de la server, din același motor care face și înregistrarea reală — deci ce vezi e ce se va scrie, nu o aproximare.

### 21 · `s16-controale` — 6:39 · voce 24 s

**Se vede:** Carton cu cele opt controale, apoi lista documentelor primite cu verdictul fiecăruia.

> Documentele citite automat trec printr-o baterie de controale înainte să intre în contabilitate: dacă aritmetica se închide, dacă cota de TVA e cea potrivită, dacă data cade într-o perioadă deschisă, dacă partenerul e cunoscut și dacă documentul nu e cumva deja înregistrat. Se postează automat doar dacă trec toate — altfel rămâne la tine, cu motivul scris.

### 22 · `s16b-flux` — 7:02 · voce 21 s

**Se vede:** **Documente primite (listă)**: coloana de stare — ciornă, validat, aprobat, postat.

> Orice înregistrare are un drum de la ciornă la postat: ciornă, validat, aprobat, postat. Doar ce e postat intră în contabilitate și în rapoarte. Pentru contabil: asta e separarea între cine introduce și cine își asumă. O ciornă se poate șterge fără urmă, un articol postat nu — el se corectează doar prin storno.

### 23 · `s17-emite` — 7:23 · voce 17 s

**Se vede:** Tabul **🧾 Emite factură**: cele trei alegeri în limbaj obișnuit, apoi formularul deschis.

> Facturile de vânzare se emit de aici. Alegi clientul, adaugi liniile, iar aplicația calculează TVA-ul, scade din stoc dacă e marfă și face nota contabilă. Factura iese în PDF cu datele firmei tale și pleacă la client pe e-mail, direct din aplicație.

### 24 · `s18-preview-efactura` — 7:41 · voce 17 s

**Se vede:** Vizualizatorul: fișierul **e-Factura (XML UBL)** randat ca factură lizibilă — furnizor, client, linii, cote, total.

> Din aceeași factură iese și fișierul pentru e-Factura, în formatul cerut de ANAF, gata de trimis în SPV. Nu tastezi nimic a doua oară. Aplicația știe și ce documente trebuie să plece obligatoriu în sistem, și le deosebește de cele care nu se raportează.

### 25 · `s19-bani` — 7:57 · voce 16 s

**Se vede:** **Încasări & plăți**: registrul lunii cu butoanele de înregistrare, apoi **Verifică extrasul bancar**.

> Faza a treia: trezoreria. Încasările și plățile se înregistrează pe bancă și pe casă, fiecare cu documentul ei. Aplicația ține soldul la zi și te avertizează când plafonul de casierie e depășit — pragul e cel din lege, nu unul inventat.

### 26 · `s19b-reconciliere` — 8:14 · voce 19 s

**Se vede:** **Verifică extrasul bancar**: rândurile potrivite automat, cele rămase nepotrivite și soldul extras ↔ contabilitate.

> Extrasul bancar se importă și se punctează automat cu facturile: aplicația potrivește sumele cu partenerii și îți arată ce a rămas nepotrivit. Tu te uiți doar la diferențe. Pentru contabil: asta e reconcilierea bancară făcută rând cu rând, nu pe total — și rămâne urma fiecărei potriviri.

### 27 · `s20-stocuri` — 8:33 · voce 14 s

**Se vede:** Tabul **Ce am pe stoc**: stocul pe gestiuni și mișcările lunii.

> Faza a patra: stocurile. Intrările de la furnizor și ieșirile spre client mișcă stocul pe gestiuni, cu cost mediu ponderat sau FIFO. Vezi oricând ce ai pe stoc, cât valorează și ce s-a mișcat în perioadă.

### 28 · `s20b-productie` — 8:47 · voce 15 s

**Se vede:** Tabul **Producție**: rețeta unui produs și o producție înregistrată — materialele ies, produsul finit intră.

> Dacă produci, ai rețete: definești ce intră într-un produs finit, iar la lansarea producției aplicația consumă materiile prime din stoc și înregistrează produsul obținut, cu costul lui. Nu trebuie să faci notele de mână.

### 29 · `s20c-inventariere` — 9:02 · voce 24 s

**Se vede:** Pagina de stocuri, jos: **lista de inventar**, cantitățile faptice, plusurile și minusurile.

> Inventarierea e o fază de sine stătătoare, cerută de lege înainte de bilanț. Scoți lista de inventar, treci cantitățile numărate faptic, iar aplicația calculează diferențele. Plusurile se înregistrează ca venit, lipsurile ca și cheltuială, iar dacă bifezi imputarea se adaugă și creanța față de gestionar, cu TVA. Fiecare inventar produce procesul lui verbal.

### 30 · `s21-salarii` — 9:26 · voce 17 s

**Se vede:** **Statul de plată**: brut, contribuții, impozit, net, pe fiecare angajat.

> Faza a cincea: salariile. Statul de plată se calculează lunar din contractele angajaților: brut, contribuții, deduceri, impozit, net. Cotele vin dintr-un singur loc, datat, nu sunt scrise prin cod — când se schimbă legea, se schimbă acolo.

### 31 · `s21b-angajati` — 9:44 · voce 18 s

**Se vede:** Tabul **Angajați**: fișa unui angajat — contract, salariu de bază, deducere, persoane în întreținere.

> Angajații au dosarul lor: contractul, salariul, deducerile personale, persoanele în întreținere, sporurile și reținerile. Concediile de odihnă și cele medicale se calculează după regulile lor, iar concediul medical pe zile calendaristice, cum cere legea.

### 32 · `s21c-regsalarii` — 10:02 · voce 18 s

**Se vede:** **Registru anual de salarii**: cumulul pe an, per angajat.

> Din statele de plată înregistrate iese registrul anual de salarii: cumulul pe tot anul, per angajat — brut, contribuții, impozit, net. E baza adeverințelor de venit și primul lucru pe care îl ceri când verifici anul. Se scrie singur, din ce ai înregistrat deja.

### 33 · `s22-mijloace` — 10:20 · voce 19 s

**Se vede:** **Mijloace fixe**: fișa unui mijloc fix și amortizarea lunară calculată automat.

> Faza a șasea: imobilizările. Un mijloc fix se înregistrează o dată, cu valoarea și durata lui de amortizare, iar de atunci aplicația calculează amortizarea în fiecare lună și o înregistrează singură. Catalogul oficial al duratelor e în aplicație, deci nu ghicești durata.

### 34 · `s22c-leasing` — 10:38 · voce 18 s

**Se vede:** **Leasing**: contractul și scadențarul ratelor, cu principal, dobândă și TVA.

> Bunurile luate în leasing se plătesc în rate, fiecare cu principal, dobândă și TVA. Salvezi contractul o dată, iar aplicația știe apoi rata fiecărei luni și o desface singură pe cele trei componente. Dacă firma nu are contracte de leasing, pagina asta nu te privește.

### 35 · `s24a-regularizari` — 10:57 · voce 24 s

**Se vede:** Carton „Faza 7 — regularizările", apoi tabul **Închiderea lunii**.

> Faza a șaptea, cea pe care programele simple o sar: regularizările de la sfârșit de perioadă. Sunt înregistrările care nu vin dintr-un document primit, ci din trecerea timpului și din realitatea economică — și fără ele bilanțul arată bine, dar nu e adevărat. Aplicația are un grup întreg de operațiuni pentru ele, plus două pagini dedicate. Le luăm pe rând.

### 36 · `s24b-reevaluare` — 11:21 · voce 26 s

**Se vede:** Închiderea lunii: zona de **reevaluare valutară** — candidații, cursul și diferența pe fiecare.

> Prima: reevaluarea soldurilor în valută. La sfârșitul lunii, creanțele și datoriile în valută se aduc la cursul de închidere, iar diferența intră ca venit sau ca și cheltuială financiară. Aplicația îți arată candidații, cursul folosit și diferența pe fiecare, înainte să înregistreze. Cursul vine automat de la Banca Națională, dar rămâne editabil — un feed căzut nu are voie să blocheze închiderea.

### 37 · `s24c-ajustari` — 11:47 · voce 24 s

**Se vede:** **Scadențar**: creanțele vechi și butonul de înregistrare a ajustării pentru depreciere.

> A doua: ajustările pentru creanțe incerte. Aplicația îți arată creanțele vechi, peste termen, și îți propune ajustarea pentru deprecierea lor. Dacă clientul plătește mai târziu, ajustarea se reia; dacă nu mai plătește niciodată, creanța se scoate din evidență ca pierdere. Pentru contabil: sunt trei operațiuni distincte, cu conturile lor, și toate rămân în jurnal.

### 38 · `s24d-storno` — 12:11 · voce 22 s

**Se vede:** **Articole stornate (corecții)**: fiecare storno legat de articolul original.

> A treia: corecțiile. Un articol postat nu se șterge niciodată — se stornează, adică se reversează printr-o notă opusă, care rămâne legată de cea originală. Ai o pagină cu toate stornările și motivul fiecăreia. Pentru contabil: asta e cerința de control intern, ca urma corecției să nu poată dispărea.

### 39 · `s24e-avans` — 12:33 · voce 33 s

**Se vede:** Carton „cheltuieli și venituri în avans", apoi formularul de adăugare document cu grupul **Regularizări**.

> A patra: delimitarea în timp. Abonamentele, chiriile și asigurările plătite în avans nu sunt cheltuiala lunii în care ai plătit, ci a lunilor pe care le acoperă. Fără pasul ăsta, o factură de asigurare anuală ar strica rezultatul unei singure luni. Ai operațiuni gata făcute pentru amândouă capetele — înregistrarea sumei în avans și recunoașterea ei pe cheltuială — și tot în grupul de regularizări stau regularizarea anuală a pro-ratei de TVA și ajustările de taxă cerute de Codul fiscal.

### 40 · `s23-registre` — 13:06 · voce 16 s

**Se vede:** **Registrul-jurnal**: toate operațiunile în ordine cronologică, cu documentul fiecăreia.

> Faza a opta: registrele obligatorii. Se scriu singure, din documentele tale. Registrul-jurnal cuprinde toate operațiunile în ordine cronologică, așa cum cere legea contabilității — nimic nu se înregistrează în afara lui.

### 41 · `s23b-carte` — 13:21 · voce 22 s

**Se vede:** **Cartea mare**: fișa unui cont — sold inițial, mișcările în ordine cu documentul lor, sold final.

> Cartea mare e cealaltă față a aceleiași contabilități: aceleași operațiuni, dar grupate pe conturi, nu pe dată. Deschizi fișa unui cont și vezi soldul inițial, fiecare mișcare în ordine, cu documentul din spatele ei, și soldul final. De aici pornește orice verificare: de la cifră, înapoi la documentul care a produs-o.

### 42 · `s23c-balanta` — 13:43 · voce 25 s

**Se vede:** **Balanța**: sold inițial, rulaj, sold final, cu verdictul debit = credit.

> Din cele două iese balanța de verificare: toate conturile pe luna aleasă, cu sold inițial, rulaj și sold final. Soldul inițial nu e o eroare — soldurile de bilanț se reportează firesc dintr-o lună în alta. Regula de aur o verifică aplicația de fiecare dată: totalul pe debit egal cu totalul pe credit. Dacă balanța nu se închide, afli aici, nu la bilanț.

### 43 · `s22d-scadentar` — 14:08 · voce 21 s

**Se vede:** **Scadențar clienți & furnizori**: soldul pe fiecare partener, pe vechimi.

> Tot din aceleași înregistrări iese scadențarul: soldul detaliat pe fiecare partener, cine îți mai datorează bani și cui mai datorezi tu, cu vechimea fiecărei sume. Pentru patron, asta e pagina din care afli pe cine trebuie să suni. Pentru contabil, e desfășurarea analitică a conturilor de clienți și furnizori.

### 44 · `s28-tva` — 14:29 · voce 23 s

**Se vede:** **TVA de plată**: decontul perioadei, defalcarea pe cote, jurnalele.

> Faza a noua: TVA-ul. Decontul se calculează din operațiunile lunii — colectat, deductibil, de plată sau de recuperat — și îți arată din ce rânduri se compune fiecare cifră. Soldul se reportează corect dintr-o lună în alta, iar aplicația știe și regimurile speciale: TVA la încasare, pro-rata, taxare inversă, regimul marjei.

### 45 · `s29-etva` — 14:52 · voce 18 s

**Se vede:** Cardul „Decont precompletat e-TVA — reconciliere".

> Decontul precompletat de ANAF se importă și se compară rând cu rând cu al tău. Vezi exact unde diferă și de ce. Diferențele vin de obicei din documente pe care partenerul le-a raportat, iar tu nu le-ai primit încă — și le găsești aici, nu într-o notificare peste trei luni.

### 46 · `s29b-etransport` — 15:10 · voce 16 s

**Se vede:** **e-Transport**: formularul ghidat al unui transport și codul UIT primit, salvat pe transport.

> Dacă transporți bunuri care intră sub obligația de raportare, declarația de transport se face tot de aici și primești codul UIT înainte de plecarea mașinii. Formularul e ghidat, iar fișierul e validat față de schema oficială înainte să plece.

### 47 · `s29c-intrastat` — 15:25 · voce 19 s

**Se vede:** Ecranul de declarații, cu Intrastat în listă; carton peste el: statistică la INS, prag pe fiecare sens.

> Intrastat e altceva decât o declarație fiscală: e o raportare statistică, la Institutul Național de Statistică, fără nicio sumă de plată. Devine obligatorie când treci de pragul anual, socotit separat pe fiecare sens — poți fi obligat la ce intră și liber la ce iese.

### 48 · `s25-inchidere` — 15:44 · voce 25 s

**Se vede:** **Închiderea lunii**: lista de pași cu starea fiecăruia, derivată din date.

> Faza a zecea: închiderea lunii. E o singură listă de pași, în ordine: documentele complete, extrasul bancar punctat, regularizările făcute, TVA-ul stabilit, declarațiile validate și depuse, aprobarea și blocarea perioadei. Starea fiecărui pas se calculează din date, nu se bifează de mână: o bifă ar rămâne adevărată și după ce datele se schimbă.

### 49 · `s25b-blocare` — 16:09 · voce 20 s

**Se vede:** Închiderea lunii, zona de blocare a perioadei, apoi cartonul despre forțare cu motiv scris.

> Când luna e închisă, perioada se blochează: nu se mai poate înregistra nimic cu dată în ea. Dacă totuși trebuie, blocajul se poate forța — dar numai de un administrator și numai cu motiv scris, care rămâne în jurnalul de audit. Pentru contabil: asta e garanția că o balanță depusă nu se schimbă în spatele tău.

### 50 · `s26-inchidere-an` — 16:29 · voce 22 s

**Se vede:** **Închiderea anului**: cei trei pași anuali.

> Faza a unsprezecea: închiderea anului. Sunt pașii care se fac o singură dată, după ce toate lunile sunt închise: calculul impozitului pe profit, apoi închiderea tuturor conturilor de venituri și de cheltuieli în contul de rezultat. Aceeași listă în ordine, cu fiecare pas explicat și cu efectul lui arătat înainte de a-l face.

### 51 · `s27-regfiscal` — 16:51 · voce 22 s

**Se vede:** **Registrul de evidență fiscală**: drumul de la rezultatul contabil la cel fiscal.

> Impozitul nu se calculează din rezultatul contabil, ci din cel fiscal. Registrul de evidență fiscală arată drumul dintre ele, rând cu rând: ce cheltuieli nu sunt deductibile, ce venituri nu se impozitează, ce limite se aplică. Codul fiscal îl cere plătitorilor de impozit pe profit, iar din el iese declarația o sută unu.

### 52 · `s26b-repartizare` — 17:13 · voce 21 s

**Se vede:** Închiderea anului, pasul de **repartizare a rezultatului**.

> După ce situațiile financiare sunt aprobate, rezultatul se repartizează: profitul trece la rezultat reportat, se constituie rezerva legală în limita prevăzută de lege, iar dacă se distribuie dividende, se rețin impozitele aferente. E ultimul pas al exercițiului și, în același timp, primul al celui următor.

### 53 · `s26c-situatii` — 17:34 · voce 23 s

**Se vede:** **Situații financiare**: contul de profit și pierdere și bilanțul, cu anul precedent alături.

> Faza a douăsprezecea: situațiile financiare anuale. Contul de profit și pierdere îți spune dacă ai câștigat sau ai pierdut în an, iar bilanțul, ce ai și ce datorezi la sfârșitul lui. Amândouă se generează din aceleași înregistrări pe care le-ai văzut până acum, cu anul precedent alături, pentru comparație. Acestea două sunt și cele care se depun electronic la ANAF.

### 54 · `s26d-anexe` — 17:58 · voce 29 s

**Se vede:** **Anexe la situații**: fluxuri de trezorerie, modificările capitalurilor proprii, note explicative.

> Situațiile financiare nu sunt doar două formulare. Anexele au pagina lor: situația fluxurilor de trezorerie, care arată de unde a venit și unde s-a dus numerarul; situația modificărilor capitalurilor proprii; și notele explicative. Sunt cerute de reglementările contabile, se generează din aceleași înregistrări și se atașează — spre deosebire de bilanț și de contul de profit și pierdere, ele nu merg în fișierul XML.

### 55 · `s30-declaratii` — 18:27 · voce 22 s

**Se vede:** **Declarații ANAF**: „📮 De depus — luna…" cu termene, stare și fișierul pe fiecare rând; catalogul complet, pliat, dedesubt.

> Faza a treisprezecea: declarațiile. Aplicația știe ce declarații îi revin firmei tale, în funcție de regimul ales, și le pregătește din datele deja înregistrate: decontul de TVA, declarațiile informative, cele de salarii, impozitul pe profit, situațiile financiare. Nu completezi formulare — le verifici.

### 56 · `s30c-situatie` — 18:48 · voce 22 s

**Se vede:** Registrul declarațiilor, derulat; carton peste el cu cele patru declarații de situație: D301, D307, D311, D107.

> Pe lângă lista lunară există declarații care apar din situație, nu din regim: decontul special, ajustările de taxă, taxa colectată cu codul anulat, beneficiarii sponsorizărilor. Nu se depun niciodată — până în luna în care se depun. Aplicația le propune singură, din operațiunile pe care le are deja înregistrate.

### 57 · `s30d-corectie` — 19:10 · voce 23 s

**Se vede:** Același registru; carton peste el: rectificativa înlocuiește, declarația de corecție atinge o singură sumă.

> Când o declarație depusă se dovedește greșită, felul corecției depinde de declarație. Decontul, informativa și declarația de salarii se înlocuiesc integral, printr-o rectificativă. Obligațiile de plată se corectează altfel, cu o declarație de corecție care atinge o singură sumă. Aplicația le generează pe amândouă, în forma cerută.

### 58 · `s30b-spv` — 19:33 · voce 19 s

**Se vede:** Tabul **Mesaje și documente din SPV**: conectarea cu certificatul firmei, indexul de încărcare și recipisele.

> Depunerea se face din aplicație, prin Spațiul Privat Virtual. Te conectezi o dată cu certificatul, iar de atunci trimiți direct și primești recipisele înapoi, în același loc. Aplicația verifică periodic dacă a venit răspunsul și îți spune dacă declarația a fost acceptată sau respinsă.

### 59 · `s31-preview-xml` — 19:52 · voce 12 s

**Se vede:** Vizualizatorul: **XML-ul D300**, aranjat pe rânduri, cu etichetele lui.

> Fiecare declarație se poate deschide și în forma ei brută, fișierul XML care pleacă efectiv la ANAF. E acolo pentru contabilii care vor să vadă exact ce se trimite, nu doar un rezumat pe ecran.

### 60 · `s32-saft` — 20:05 · voce 15 s

**Se vede:** Tabul **SAF-T (D406)**: ce pleacă în fișier.

> Fișierul standard de control fiscal se generează tot de aici, în toate variantele lui: lunar, la cerere și cel anual pentru active și stocuri. E cel mai voluminos lucru pe care îl cere ANAF-ul și, aici, se face dintr-un buton.

### 61 · `s31b-validare` — 20:20 · voce 21 s

**Se vede:** Carton pe ecran plin: fiecare declarație trece validatoarele oficiale ANAF.

> Și acum lucrul care contează cel mai mult: fiecare declarație generată de aplicație e verificată cu validatoarele oficiale ale ANAF, nu doar cu testele noastre. Verificarea rulează la fiecare modificare a codului, iar o declarație care nu trece nu ajunge în produs. „N-am putut verifica” se tratează la fel ca „e greșit”.

### 62 · `s34-arhiva` — 20:41 · voce 20 s

**Se vede:** **Arhivă documente**: dosarul lunii.

> Faza a paisprezecea, ultima: arhivarea. Dosarul lunii adună la un loc documentele, registrele și declarațiile perioadei, într-o singură arhivă. Dosarul anual se închide și rămâne neschimbat. Legea cere păstrarea lor ani buni — aici nu e o promisiune, e un fișier pe care îl descarci.

### 63 · `s33-rapoarte` — 21:01 · voce 17 s

**Se vede:** Rapoartele de conducere: încasări pe perioade, cheltuieli pe categorii, previziunea de numerar.

> Peste ciclu stau rapoartele de conducere, cele care nu se depun nicăieri, dar din care conduci firma: încasările pe perioade, cheltuielile pe categorii, profitabilitatea, previziunea de numerar. Se citesc pe ecran sau se scot în PDF și în tabel.

### 64 · `s33b-buget` — 21:18 · voce 16 s

**Se vede:** **Buget vs realizat**, lună de lună, apoi **Scadențarul** clienți/furnizori pe vechimi.

> Poți pune un buget pe an și pe categorie, iar aplicația îți arată realizatul lângă el, lună de lună, cu diferența. Pentru o firmă mică, e diferența dintre a afla în ianuarie următor că ai depășit și a afla în martie, când mai poți face ceva.

### 65 · `s24-preview-csv` — 21:34 · voce 17 s

**Se vede:** Vizualizatorul: balanța ca **fișier CSV**, în text simplu, coloană cu coloană.

> Orice listă din aplicație iese în tabel, gata de deschis în Excel. Textele care ar putea fi citite ca formule sunt neutralizate la export, iar sumele rămân numere — un detaliu mic, până când cineva deschide fișierul și vede altceva decât ce ai trimis.

### 66 · `s22b-parteneri` — 21:51 · voce 19 s

**Se vede:** **Clienți & furnizori**: completarea după CUI (denumire, adresă, plătitor de TVA de la ANAF) și soldul fiecărui partener.

> Clienții și furnizorii se completează din codul fiscal: aplicația întreabă registrul ANAF și aduce denumirea, adresa și starea de plătitor de TVA. Afli din aplicație dacă un partener e inactiv sau i s-a anulat codul de TVA — înainte să înregistrezi factura, nu după.

### 67 · `s35-setari` — 22:09 · voce 15 s

**Se vede:** Setările, parcurse: Firma mea, Contul meu, Cine are acces, Date & copii de siguranță, Conexiuni.

> Setările firmei sunt locul din care se schimbă tot ce ține de identitatea ei: datele de pe facturi, seriile de documente, logoul, conturile bancare, regimul de TVA și cel de impozitare. Se completează o dată, la început.

### 68 · `s36-audit` — 22:24 · voce 19 s

**Se vede:** **Jurnal de audit**: cine a făcut ce și când.

> Tot ce se întâmplă în aplicație se scrie în jurnalul de audit: cine a intrat, ce a modificat, când și de la ce adresă. Nu se poate șterge din interfață, iar jurnalul se scrie și pe disc, separat de baza de date. Pentru un contabil care răspunde profesional, asta nu e un lux.

### 69 · `s36b-cautare` — 22:44 · voce 16 s

**Se vede:** Paleta de căutare (Ctrl+K) cu un rezultat ales, **Dicționarul** deschis peste ea, apoi comutarea pe modul simplu.

> Căutarea merge peste tot deodată: scrii un număr de factură, un nume de partener sau o sumă, și primești documentele, înregistrările și partenerii care se potrivesc. E felul cel mai scurt de a răspunde la întrebarea „ce am făcut cu factura aia”.

### 70 · `s36c-carte` — 23:00 · voce 19 s

**Se vede:** Ghidul din aplicație, derulat; carton peste el: cartea despre contabilitate, pe același drum ca aplicația.

> Iar dacă vrei să înțelegi, nu doar să apeși butoane, aplicația vine cu o carte întreagă despre contabilitatea românească, așezată pe același drum pe care tocmai l-ai văzut: documentul, banii, registrele, declarațiile, închiderea. Se citește în browser sau se descarcă gata de tipar.

### 71 · `s37-incredere` — 23:19 · voce 20 s

**Se vede:** Pagina de backup, apoi cartonul „Validat cu validatorul publicat de ANAF".

> Datele stau la tine, nu se pierd. Copia de siguranță se face automat în fiecare zi, se verifică singură prin restaurare de probă, și pleacă criptată în afara serverului. Sună tehnic, dar înseamnă un lucru simplu: dacă serverul arde diseară, contabilitatea firmei tale există mâine dimineață.

### 72 · `s37b-recuperare` — 23:39 · voce 17 s

**Se vede:** Ecranul „Date & copii de siguranță", zona de backup; carton peste el: arhivă criptată, în afara serverului, cu refacerea probată.

> Copia de siguranță nu e doar o bifă în setări. Arhiva zilnică e criptată, pleacă în afara serverului, iar refacerea din ea se probează automat — inclusiv pe o mașină goală, cu unelte obișnuite, ca recuperarea să nu depindă de programul care tocmai s-a pierdut.

### 73 · `s38-limite` — 23:57 · voce 20 s

**Se vede:** Carton pe ecran plin: ce rămâne la patron și la contabil.

> Și ce nu face. Nu ține locul contabilului: nu semnează bilanțul și nu răspunde în fața ANAF. Nu inventează documente care nu există. Nu e făcută pentru corporații cu mii de angajați, ci pentru firme mici și mijlocii și pentru contabilii care le țin. Dacă asta ești, e făcută exact pentru tine.

### 74 · `s39-final` — 24:16 · voce 7 s

**Se vede:** Carton final: „30 de zile gratuit, fără card · contabo.space".

> Contabo. Treizeci de zile de probă, fără card. Intră, adaugă prima factură și vezi singur.

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
9. Ecranul de pe telefon (același meniu deschis ca sertar), 5 secunde — dovada că ierarhia rămâne identică pe mobil.
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
`scripts/video-prezentare.mjs` conduce aplicația prin cele 74 de scene și înregistrează ecranul
(Playwright înregistrează nativ, fără ffmpeg pe gazdă), iar `scripts/video-montaj.mjs` așază vocea
peste imagine și scoate mp4-ul. Rezultatul publicat este la **1280×720, cu narațiune în română**;
durata, dimensiunea și amprenta lui se citesc din `/descarcari/video.json`, manifest scris
automat la publicare, ca documentația să nu păstreze o durată veche după următorul montaj.

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

**Cum se verifică filmul complet fără să-l urmărești cap-coadă:** montajul scoate un **contact** —
câte un cadru din fiecare scenă, în grilă. Se compară cu lista din capitolul 3: dacă tabloul din
dreptul unei replici arată alt ecran, sincronizarea sau ordinea sunt greșite. Așa s-au prins șapte
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
7. **Actorii care dețin sau aprobă firme sunt conturi privilegiate** și, fără 2FA în decor, API-ul
   răspundea 428: meniurile se mișcau, dar listele filmate rămâneau goale.

---

## 9. Verificări înainte de publicare

- [ ] Toate cifrele rostite s-au reverificat în ziua montajului: numărul de verificări din suită,
      tipurile de operațiuni, prețul (99 lei/lună/firmă în Start și Pro, probă 30 de zile fără card).
- [ ] Niciun CUI, nume sau adresă reală de client în cadru; doar firma-exemplu din seed.
- [ ] Nicio secvență filmată pe demoul public (datele lui se schimbă zilnic, de la vizitatori).
- [ ] Cartușul de limite (capitolul 4) e prezent în varianta principală — în filmul înregistrat e
      scena `s22-limite`, rostită integral.
- [ ] Contactul de imagini a fost comparat cu lista de scene din capitolul 3.
- [ ] Fiecare ecran arătat există în versiunea publicată — se revede filmul cu aplicația alături.
- [ ] Adresa din cardul final e lizibilă și corectă, iar butonul de probă chiar duce la înscriere.
- [ ] Subtitrarea a fost citită de cineva care nu a lucrat la film (greșelile proprii nu se văd).
