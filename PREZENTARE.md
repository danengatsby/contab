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
> Fiecare versiune trece prin validatorul oficial ANAF. 30 de zile gratuit, fără card.

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
| **107** | tipuri de operațiuni gata pregătite — alegi în limbaj simplu, aplicația pune conturile |
| **10** | declarații și situații: D300, D394, D112, D390, D100, D101, D205, SAF-T (D406), Intrastat, bilanț |
| **4.393** | verificări automate rulate la fiecare versiune, înainte să ajungă la tine |

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
3. La final de lună apeși „Închide TVA". Decontul D300 e deja completat, defalcat pe cote.

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

**Documente și facturare** — 107 tipuri de operațiuni · facturi cu serie continuă · e-Factura UBL
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

**Bancă și casă** — import extras CSV/MT940 · potrivire automată a încasărilor cu partenerii ·
control de sold și plafon de casierie · fișier de plăți SEPA (pain.001) · curs BNR automat

**Imobilizări** — registru de mijloace fixe · amortizare liniară, degresivă, accelerată ·
amortizare fiscală separată de cea contabilă · leasing financiar cu grafic de rate

**Siguranță** — cont propriu cu parolă și 2FA · jurnal de audit · backup zilnic automat cu copie
în afara serverului · exercițiu de restaurare verificat periodic

---

## 7. De ce poți avea încredere

### Fiecare versiune trece prin validatorul oficial ANAF

Nu spunem „conform ANAF" și atât. **Înainte ca o versiune să ajungă la tine**, declarațiile
generate de aplicație sunt trecute prin **DUKIntegrator — validatorul publicat de ANAF** — și prin
schema oficială XSD pentru e-Transport. Dacă o singură declarație e respinsă, versiunea nu se
publică.

Mai mult: dacă validarea *nu poate rula* (serviciul ANAF e picat, schema lipsește), versiunea tot
nu se publică. **„N-am putut verifica" nu înseamnă „e bine".**

### 4.393 de verificări automate, la fiecare versiune

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
| | 30 de zile, **fără card** | **99 lei** / lună | **199 lei** / lună |
| Pentru | testezi tot | antreprenori care își țin singuri evidența | contabili și portofolii de firme |
| Funcții | toate | toate | toate |
| Suport prioritar | — | ✓ | ✓ |

**Fără module plătite separat.** Stocurile, producția, salarizarea și declarațiile sunt incluse din
prima zi. Planurile se diferențiază prin preț, nu prin funcții — ca să nu descoperi la final de an
că lucrul de care ai nevoie e „în alt pachet".

**După probă, datele rămân.** Alegi un plan și continui exact de unde ai rămas.

`[ Începe proba gratuită ]` — durează două minute și nu cere card.

---

## 9. Ce face aplicația — și ce rămâne la tine

Preferăm să știi dinainte. Contabo te duce până aproape de capăt: contabilitate corectă și
formatele cerute de ANAF. Ultimii pași rămân, ca la orice program, în grija ta:

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

## 12. Variante scurte pentru rețele sociale

**Pentru antreprenori**
> Cât profit ai făcut luna asta? Dacă răspunsul vine peste trei săptămâni, de la contabil, e prea
> târziu ca să mai schimbi ceva. Contabo îți arată profitul, taxele și banii disponibili după
> fiecare document înregistrat. 30 de zile gratuit, fără card.

**Pentru contabili**
> Zece firme, zece termene, zece dosare de deschis ca să afli cine are restanțe. Sau un singur
> ecran care ți le arată pe toate. Contabo — multi-firmă, cu tablou de conformitate și digest
> zilnic pe e-mail.

**Despre încredere**
> Cele mai multe programe de contabilitate spun „conform ANAF". Noi trecem fiecare versiune prin
> validatorul publicat de ANAF înainte să ajungă la tine. Dacă o declarație e respinsă, versiunea
> nu se publică.

**Despre preț**
> Fără module plătite separat. Stocuri, producție, salarizare și toate declarațiile sunt incluse
> din prima zi, în orice plan. Planurile diferă prin preț, nu prin funcții.

**Despre citirea automată**
> Fotografiezi factura, o tragi în aplicație, iar furnizorul, baza și TVA-ul se completează
> singure. Înainte de a fi acceptată, trece prin verificări de aritmetică, cotă, dată, duplicat și
> partener. Tu confirmi — postarea automată e oprită până când o ceri.
