# Scenariu — video de prezentare Contabo

Scenariu de filmare (screencast cu voce), gata de dat unui editor video. **Fiecare afirmație din
voice-over e verificabilă în aplicație** — dacă schimbi ceva aici, verifică întâi în produs, ca la
`PREZENTARE.md`: o promisiune ratată la ANAF costă mai mult decât o vizionare câștigată.

- **Public:** patroni de firme mici (nu știu contabilitate) + contabili cu portofolii de firme.
- **Obiectiv:** o singură idee — *aduci documentele, aplicația face contabilitatea și declarațiile,
  iar ordinea în care lucrezi e chiar ciclul contabil.*
- **Ton:** calm, concret, fără superlative. Se arată ecrane reale, nu ilustrații.
- **Durata:** varianta principală **3:40**; variante scurte de 60 s, 30 s și 15 s (capitolul 5).
- **Format:** 1920×1080, 30 fps, voce română + subtitrare arsă (mulți se uită fără sunet).

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
| Rezoluție browser | 1440×900, `deviceScaleFactor: 2` (imagine curată la 1080p) |
| Temă | **clară** pentru filmul principal; o singură secvență pe temă întunecată (buton 🌙) |
| Mod | pornim în **Simplu**, comutăm pe **Expert** în scena registrelor (buton 🎓/🛠) |
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

## 3. Scenariul principal (3:40)

Legendă coloane: **IMAGINE** = ce se vede și ce se apasă · **VOCE** = textul citit ·
**TEXT PE ECRAN** = titrajul suprapus (scurt, 3–6 cuvinte).

---

### Scena 0 · Cârligul — 00:00–00:12

| | |
|---|---|
| **IMAGINE** | Cadru real, nu ecran: un teanc de facturi pe birou, telefonul deasupra. Tăietură la ecran: aplicația deschisă pe **Acasă**, cu cardurile de venituri, cheltuieli, rezultat, TVA de plată și disponibil. |
| **VOCE** | „Câți bani a făcut firma ta luna asta? Dacă răspunsul vine peste trei săptămâni, de la contabil, întrebarea a rămas fără rost. Contabo îți răspunde în timp ce lucrezi." |
| **TEXT PE ECRAN** | `Cât profit am făcut luna asta?` → `Răspunsul, acum.` |
| **MONTAJ** | Prima tăietură la 00:04 — prima linie decide dacă se uită mai departe. |

---

### Scena 1 · Ce este — 00:12–00:25

| | |
|---|---|
| **IMAGINE** | Zoom lent pe tabloul de bord. Se trece cu mouse-ul peste cardurile de KPI (culoarea vine din valoare, nu din tipul cardului — profit verde, pierdere roșu). |
| **VOCE** | „Contabilitate românească în partidă dublă, cu planul de conturi oficial. Tragi documentul în aplicație — Contabo alege conturile, ține registrele, calculează TVA-ul și pregătește declarațiile pentru ANAF." |
| **TEXT PE ECRAN** | `Contabilitate românească · OMFP 1802/2014 · parametri fiscali 2026` |

---

### Scena 2 · Documentul primit — 00:25–00:58

| | |
|---|---|
| **IMAGINE** | Meniu → **📥 Documente & facturi** → **➕ Adaugă document primit**. Se trage un PDF de factură peste zona de încărcare. Câmpurile se completează singure: furnizor, CUI, număr, dată, bază, TVA, total. Se arată **previzualizarea articolului contabil** (conturile propuse), apoi „Salvează". |
| **VOCE** | „O factură primită: o tragi în aplicație. Furnizorul, CUI-ul, baza și TVA-ul se completează singure, iar aplicația îți arată dinainte ce notă contabilă va face. Tu verifici și confirmi." |
| **TEXT PE ECRAN** | `Tragi factura. Restul se completează.` |
| **PLAN DETALIU** | Cadru pe lista de tipuri: **107 tipuri de operațiuni**, alese în limbaj obișnuit („factură de la furnizor", „încasare de la client") — nu coduri de cont. |
| **VOCE (continuare)** | „Nu trebuie să știi formula contabilă. Alegi ce document ai în mână; conturile le pune aplicația." |
| **ATENȚIE** | Se filmează și mesajul de control când ceva nu se potrivește (bază + TVA ≠ total). **Postarea automată e oprită implicit** — se spune explicit, e un argument de încredere, nu o scăpare. |

---

### Scena 3 · Factura emisă și e-Factura — 00:58–01:20

| | |
|---|---|
| **IMAGINE** | **📥 Documente & facturi → 🧾 Emite factură**. Se completează două linii, se apasă generarea. Split-screen: **PDF-ul pentru client** (cu logo) și **XML-ul e-Factura** pentru SPV. Apoi butonul de trimitere în SPV și starea/recipisa. |
| **VOCE** | „Emiți o factură: primești PDF-ul pentru client și fișierul e-Factura pentru SPV, cu numărul în serie continuă. Trimiterea și recipisa rămân în aplicație." |
| **TEXT PE ECRAN** | `PDF pentru client · e-Factura pentru ANAF` |
| **B-ROLL** | Pe fundal, tot din acest grup: documente primite (listă), galerie de documente. |

---

### Scena 4 · Banii — 01:20–01:38

| | |
|---|---|
| **IMAGINE** | **🏦 Bani → Verifică extrasul bancar**. Import de extras (CSV/MT940); rândurile se potrivesc singure cu partenerii și cu facturile. Apoi **Încasări & plăți (bancă / casă)**. |
| **VOCE** | „Extrasul bancar se importă și se potrivește singur cu facturile tale. Ce nu se potrivește rămâne evidențiat — acolo te uiți, nu în toată luna." |
| **TEXT PE ECRAN** | `Extrasul, pus față în față cu facturile` |

---

### Scena 5 · Ce mișcă lunar — 01:38–02:00

Montaj rapid, trei tăieturi de câte ~7 secunde, cu aceeași mișcare de meniu (se vede că sunt trei
grupuri consecutive — asta *arată* ordinea, nu doar o spune).

| | |
|---|---|
| **IMAGINE 1** | **📦 Stocuri → Ce am pe stoc**: stocul pe gestiuni, o mișcare înregistrată, situația PDF. |
| **IMAGINE 2** | **👥 Salarii → Statul de plată (lunar)**: tabelul cu brut, CAS, CASS, impozit, net; butonul „Înregistrează salariile lunii"; fluturașul PDF. |
| **IMAGINE 3** | **🏢 Mijloace fixe → Mijloace fixe (amortizare)**: registrul și „Înregistrează amortizarea lunii". |
| **VOCE** | „Stocuri la cost mediu sau FIFO. State de plată cu cotele în vigoare, cu concedii, tichete și avantaje. Amortizarea mijloacelor fixe, într-un buton. Toate intră singure în contabilitate — nu le mai înregistrezi a doua oară." |
| **TEXT PE ECRAN** | `Stocuri · Salarii · Amortizare` |

---

### Scena 6 · Registrele — 02:00–02:15

| | |
|---|---|
| **IMAGINE** | Comutare pe modul **Expert** (butonul 🛠) — apar grupurile tehnice. **📒 Registre contabile** → *Toate operațiunile (jurnal)* → *Fișa fiecărui cont* → **Solduri conturi (balanță)**, unde se vede mesajul „Balanța se închide — cele patru egalități sunt respectate". |
| **VOCE** | „Registrele obligatorii se scriu singure: jurnalul, fișa fiecărui cont, balanța. Iar balanța îți spune singură dacă se închide." |
| **TEXT PE ECRAN** | `Balanța se închide ✔` |
| **NOTĂ** | Aici se arată și comutatorul Simplu/Expert: în modul simplu partea tehnică e ascunsă, ca un nespecialist să nu se lovească de ea. |

---

### Scena 7 · Închiderea lunii — 02:15–02:42

Scena cea mai importantă pentru contabili. Se filmează încet, fără accelerare.

| | |
|---|---|
| **IMAGINE** | **🔒 Închideri → Închiderea lunii**. Se vede cockpitul: pașii numerotați (documente complete, extras bancar și punctaj, TVA regularizat, declarații validate și depuse, aprobare, blocare), fiecare cu starea lui — *gata*, *de făcut*, *așteaptă* — plus motivul concret („1 furnizor obișnuit fără document în lună"). Se apasă un pas și se ajunge direct în ecranul care îl rezolvă. |
| **VOCE** | „La final de lună ai o singură listă de pași, în ordine. Starea fiecărui pas **se calculează din date**, nu se bifează de mână — o bifă ar rămâne adevărată și după ce datele se schimbă. Iar dacă ceva lipsește, îți spune exact ce." |
| **TEXT PE ECRAN** | `Starea se calculează din date. Nu se bifează.` |
| **PLAN DETALIU** | Butoanele „Aprobă luna" și „Blochează perioada", plus mențiunea că închiderea peste pași deschiși cere drept de administrator **și motiv scris**. |

---

### Scena 8 · Taxele și declarațiile — 02:42–03:08

| | |
|---|---|
| **IMAGINE** | **🧾 Taxe & declarații → TVA de plată (decont)**: decontul D300 defalcat pe cote, jurnalele de vânzări și cumpărări. Apoi **Declarații ANAF**: lista lunii cu termene și registrul depunerilor; se descarcă un XML și rândul devine „generată". Tăietură scurtă la **SAF-T (D406)** și la **Mesaje și documente din SPV**. |
| **VOCE** | „TVA-ul e calculat din documentele tale, defalcat pe cote, cu jurnalele aferente. D300, D394, D112, SAF-T — se generează, se descarcă, iar registrul ține minte ce ai depus și când." |
| **TEXT PE ECRAN** | `D300 · D394 · D112 · SAF-T (D406)` |
| **PLAN DETALIU** | Avertismentul din aplicație: declarațiile sunt **ciorne** până le validezi cu DUKIntegrator. Se citește pe ecran, nu se ascunde. |

---

### Scena 9 · De ce poți avea încredere — 03:08–03:28

| | |
|---|---|
| **IMAGINE** | Trei planuri scurte: (a) terminal cu rezultatul suitei — `Toate suitele au trecut`; (b) raportul poartei fiscale cu verdictul validatorului oficial; (c) **⚙️ Setări → 💾 Date & copii de siguranță** — backupul zilnic și ultima restaurare de probă. |
| **VOCE** | „Înainte ca o versiune să ajungă la tine, declarațiile trec prin validatorul publicat de ANAF, iar peste patru mii șase sute de verificări automate rulează la fiecare modificare. Dacă validarea nu poate rula, versiunea nu se publică: «n-am putut verifica» nu înseamnă «e bine»." |
| **TEXT PE ECRAN** | `Validat cu DUKIntegrator · 4.661 verificări automate` |
| **NOTĂ DE ACTUALIZARE** | Numărul se ia din rularea reală a suitei în ziua montajului; nu se scrie din memorie. |

---

### Scena 10 · Pentru contabili + final — 03:28–03:40

| | |
|---|---|
| **IMAGINE** | **🗂 Portofoliu**: firmele, procentul de conformitate, restanțele. Tăietură la ecranul de preț. Card final cu adresa și butonul de probă. |
| **VOCE** | „Dacă ții mai multe firme, le vezi pe toate deodată: ce e depus, ce e restant, unde e o eroare. Treizeci de zile gratuit, fără card. Datele rămân ale tale." |
| **TEXT PE ECRAN** | `contabo.space · 30 de zile gratuit, fără card` |
| **MONTAJ** | Ultimul cadru rămâne pe ecran 3 secunde, static, cu adresa lizibilă. |

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

## 8. Verificări înainte de publicare

- [ ] Toate cifrele rostite s-au reverificat în ziua montajului: numărul de verificări din suită,
      tipurile de operațiuni, prețurile (99 lei Start, 199 lei Pro, probă 30 de zile fără card).
- [ ] Niciun CUI, nume sau adresă reală de client în cadru; doar firma-exemplu din seed.
- [ ] Nicio secvență filmată pe demoul public (datele lui se schimbă zilnic, de la vizitatori).
- [ ] Cartușul de limite (capitolul 4) e prezent în varianta principală.
- [ ] Fiecare ecran arătat există în versiunea publicată — se revede filmul cu aplicația alături.
- [ ] Adresa din cardul final e lizibilă și corectă, iar butonul de probă chiar duce la înscriere.
- [ ] Subtitrarea a fost citită de cineva care nu a lucrat la film (greșelile proprii nu se văd).
