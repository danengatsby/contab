# Controlul bilanțului F10

Generarea XML a situațiilor financiare este „fail closed”. Aplicația nu modifică automat
rezultatul reportat (117 / rândurile F10 041–042 sau 095–096) pentru a obține egalitatea
Activ–Pasiv.

## Toleranța de rotunjire

Rândurile elementare se rotunjesc la lei înaintea totalurilor, conform schemei ANAF. Validatorul
cere egalitate exactă și nu acceptă nici măcar diferența de un leu produsă de rotunjiri
independente. De aceea, un reziduu de cel mult **1 leu** (`TOLERANTA_ROTUNJIRE_LEI`) este alocat
determinist rândului elementar care se îndepărtează cel mai puțin de valoarea sa în bani. Alocarea
este vizibilă în `mappingReport.roundingAdjustments` și nu modifică rezultatul F20 sau 117.
O diferență mai mare blochează XML-ul; o corecție economică necesită registrul ajustărilor.

## Metadatele de mapare

Registrul `balance_sheet_mappings` este versionat append-only și păstrează, pe exercițiu și cont:

- scadența și/sau porțiunea exigibilă în următoarele 12 luni;
- relația cu entitatea (`none`, `affiliate`, `associate`);
- linia F10 prescurtată/completă și, opțional, o linie F20 „din care”;
- motivul, autorul, hash-ul versiunii și hash-ul versiunii precedente.

Conturile 16 și 471 fără scadență ori porțiune curentă nu sunt clasificate implicit. Ele apar cu
soldul lor în raportul conturilor nemapate și blochează XML-ul. În F10 complet, afilierea
neconfirmată este de asemenea o metadată obligatorie pentru creanțele și datoriile comerciale.

## Ajustările manuale

Registrul `balance_sheet_adjustments` este separat de jurnalul contabil. Fiecare ajustare indică
exercițiul, varianta F10, rândul elementar, suma în lei, motivul, aprobatorul și două hash-uri:
hash-ul sursei (balanță + rulajele F20 + mapările active) și hash-ul înlănțuit al înregistrării.
Schimbarea ulterioară a sursei expiră automat aprobarea și blochează generarea.

## Reconcilierea obligatorie

Înainte de XML sunt verificate pentru exercițiul curent și precedent:

1. cele patru egalități ale balanței de verificare;
2. acoperirea cont-cu-cont și diferența F10 față de balanță;
3. egalitatea rezultatului exercițiului din F10 cu rezultatul din F20;
4. integritatea metadatelor și a registrului ajustărilor.

Raportul este disponibil la `GET /api/balance-sheet-controls?year=YYYY&category=micro|mic|mare`.
Metadatele și ajustările se administrează prin rutele `/api/balance-sheet-mappings` și
`/api/balance-sheet-adjustments`; mutațiile cer drepturile de configurare fiscală, respectiv de
aprobare a declarației.
