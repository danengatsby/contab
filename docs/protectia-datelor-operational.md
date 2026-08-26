# Dosar operațional pentru activarea datelor reale

Stare la 26 august 2026: **NEACTIVAT**. Acest document este un registru de implementare, nu o
confirmare că obligațiile au fost îndeplinite. Responsabilul desemnat completează dovezile, iar
avocatul/DPO-ul validează rolurile, temeiurile și contractele înainte de setarea
`CONTAB_REAL_DATA_ENABLED=1`.

Poarta tehnică este în `src/legalCompliance.js`. Ea blochează datele reale și încasările până când
identitatea este publicată în documentele juridice, toate procedurile de mai jos au versiune și
operatorul firmei acceptă explicit documentele curente. Acceptarea păstrează actorul, data,
versiunea și SHA-256-ul fiecărui document.

## 1. Registrul activităților de prelucrare (ROPA)

Se păstrează într-un registru controlat, versionat și aprobat. Un rând pentru fiecare activitate:

| Câmp obligatoriu | Exemplu de completare / decizie cerută |
|---|---|
| Activitate | conturi; găzduire dosar contabil; salarizare; suport; securitate; plăți; AI |
| Rol Contabo | operator pentru cont/securitate/facturare; împuternicit pentru dosarul firmei |
| Scop și temei | contract, obligație legală, interes legitim sau instrucțiunea operatorului |
| Persoane vizate | utilizatori, angajați, colaboratori, reprezentanți/parteneri |
| Categorii de date | identificare, CNP, contact, financiar-contabil, salarial, sănătate minimă |
| Destinatari | ANAF la comanda clientului; subîmputerniciții aprobați |
| Transfer | țară, mecanism, SCC/decizie de adecvare și evaluare suplimentară |
| Retenție | termen, eveniment de pornire, sistem activ, backup, audit |
| Măsuri | control acces, criptare, jurnal, backup, ștergere, minimizare |
| Proprietar intern | nume/funcție reale, nu „echipa” |
| Dovadă | contract, ticket, captură/config, raport de test, dată de revizuire |

După aprobare se setează `CONTAB_GDPR_ROPA_VERSION=<versiune>`. O versiune goală nu trece poarta.

## 2. Incidente de securitate

Procedura trebuie să definească, cel puțin:

1. canal 24/7 și înlocuitor pentru persoana de gardă;
2. număr unic, momentul detectării și momentul luării la cunoștință;
3. conservarea probelor fără alterarea jurnalului de audit;
4. izolarea incidentului și analiza firmelor/persoanelor/categoriilor afectate;
5. evaluarea probabilității și severității riscului;
6. notificarea operatorilor fără întârziere, cu informațiile disponibile în etape;
7. sprijin pentru decizia operatorului privind ANSPDCP și persoanele vizate;
8. lecții învățate, măsuri, proprietar și termen de închidere.

Registrul incidentelor se păstrează inclusiv când concluzia este „fără notificare”, împreună cu
raționamentul. După exercițiul de masă și aprobarea procedurii se setează
`CONTAB_GDPR_INCIDENT_PROCEDURE_VERSION=<versiune>`.

## 3. Solicitări GDPR

Flux: primire → număr unic → verificare proporțională a identității → stabilirea rolului Contabo →
localizarea datelor → blocarea ștergerilor conflictuale → răspuns/transfer către operator → dovadă
de livrare → închidere. Registrul conține termene, decizii, excepții și aprobator.

Pentru datele angajaților/partenerilor, Contabo nu răspunde în locul operatorului: transmite cererea
firmei și oferă căutare, export, rectificare sau ștergere conform instrucțiunii documentate. Procedura
trebuie să trateze separat copiile de siguranță și obligațiile legale de păstrare. După testarea unui
caz de acces, rectificare, portabilitate și ștergere se setează
`CONTAB_GDPR_RIGHTS_PROCEDURE_VERSION=<versiune>`.

## 4. Subîmputerniciți și transferuri

Pentru fiecare furnizor se verifică înainte de lansare și apoi cel puțin anual: entitatea
contractantă exactă, serviciul, datele primite, locațiile, subcontractanții, retenția, folosirea
datelor pentru antrenare, măsurile de securitate, notificarea incidentelor, ștergerea și dreptul de
audit. Lista publică trebuie să coincidă cu configurația efectivă.

Pentru un transfer în afara SEE se păstrează mecanismul concret (adecvare sau SCC aplicabile),
modulul/rolurile corecte, anexele completate, evaluarea legislației/practicii țării și măsurile
suplimentare. Menționarea generică „SCC” în DPA nu este dovadă de implementare. După verificare se
setează data `CONTAB_GDPR_SUBPROCESSORS_REVIEWED_AT=YYYY-MM-DD` și
`CONTAB_GDPR_TRANSFER_ASSESSMENT_VERSION=<versiune>`.

## 5. Retenție și ștergere

Matricea aprobată trebuie să indice pentru fiecare categorie: sistemul, termenul, evenimentul de la
care curge, temeiul, excepțiile/hold-ul, metoda de ștergere și testul. Politica actuală declară:

- accesări agregate pe IP: 30 zile;
- sesiuni: 7 zile de inactivitate;
- staging de import: 24 ore;
- backup local: 30 generații DB și 14 arhive complete;
- backup offsite: până la 180 zile, dacă este configurat astfel;
- date firmă/cont: până la ștergere, cu export și termen operațional documentat;
- audit: termen separat, justificat prin securitate și apărarea drepturilor.

Un test de ștergere trebuie să urmărească aceeași înregistrare în baza vie, fișiere, indexuri,
cache, exporturi temporare și rotația backup. Orice diferență dintre politică și configurație oprește
lansarea.

## 6. Evaluarea riscului / DPIA

Evaluarea este necesară înainte de lansare și la schimbarea scopului, furnizorului AI, modelului,
volumului sau categoriilor de date. Minimum de scenarii:

| Risc | Impact | Control minim înainte de lansare | Dovadă |
|---|---|---|---|
| acces neautorizat la CNP | furt de identitate, fraudă | nevoie-de-a-cunoaște, MFA pentru roluri privilegiate/salarii, mascarea în UI/export/log | test roluri + capturi/red-team |
| divulgarea salariilor | prejudiciu profesional și social | permisiune dedicată, separare pe firmă, audit al exportului, notificare acces anormal | teste HTTP/E2E + revizie audit |
| date medicale excesive | discriminare, atingerea vieții private | câmpuri minime; fără diagnostic/anexe; restricție salarizare; retenție justificată | inventar câmpuri + test export |
| document cu CNP trimis la AI | transfer extern și pierderea controlului | opt-in per firmă implicit oprit, furnizor/model vizibil, minimizare/redactare, contract și transfer verificate | acceptare versionată + log |
| restaurarea readuce date șterse | nerespectarea ștergerii/restricției | registru de ștergeri aplicat după restore, backup izolat, exercițiu documentat | raport restore/erasure drill |
| admin/impersonare abuzivă | acces transversal la clienți | reautentificare/MFA, motiv/ticket/TTL, notificare, audit WORM | test și eșantion trimestrial |

Pentru fiecare risc se notează probabilitatea și severitatea înainte/după controale, acceptantul
riscului rezidual și data reanalizării. Dacă riscul ridicat nu poate fi redus suficient, lansarea
rămâne oprită și se evaluează consultarea prealabilă. După aprobare se setează
`CONTAB_GDPR_DPIA_VERSION=<versiune>`.

## 7. Checklist de activare

- [ ] Societatea furnizoare există și identitatea integrală este publicată identic în Termeni/DPA.
- [ ] DPA-ul a fost revizuit juridic și mecanismul de acceptare a fost testat end-to-end.
- [ ] ROPA, incidente, drepturi și DPIA au proprietar, versiune, aprobare și dovezi.
- [ ] Contractele subîmputerniciților și transferurile corespund configurației de producție.
- [ ] Retenția/ștergerea a trecut un test de bază vie + fișiere + backup + restore.
- [ ] Opt-in-ul AI a fost testat: implicit off, activare/revocare per firmă, fallback local.
- [ ] `GET /api/legal-status` răspunde `ready: true` fără elemente `missing`.
- [ ] O firmă pilot acceptă versiunile curente; schimbarea unui document invalidează acceptarea.
- [ ] Abia la final se setează `CONTAB_REAL_DATA_ENABLED=1` și se repornește procesul.

Surse de control: [GDPR, inclusiv art. 28](https://eur-lex.europa.eu/legal-content/RO/TXT/?uri=CELEX:32016R0679),
[orientările EDPB 07/2020 privind operatorul și persoana împuternicită](https://www.edpb.europa.eu/documents/guideline/guidelines-072020-on-the-concepts-of-controller-and-processor-in-the-gdpr_en),
[SCC ale Comisiei Europene](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/standard-contractual-clauses-scc_en).
