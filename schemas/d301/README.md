# D301 — decont special de TVA: schelet VALIDAT

`exemplu-valid.xml` e un D301 complet care **trece validatorul oficial ANAF**
(`scripts/valideaza-duk.sh D301 schemas/d301/exemplu-valid.xml`). Nu e generat de aplicație —
generatorul nu există încă; e artefactul recunoașterii din 2026-08-07.

De ce e ținut în depozit și nu regenerat la nevoie: reconstruirea lui a costat șapte rulări ale
validatorului oficial (fiecare pornește un container Java și descarcă jar-uri de la ANAF), iar
regulile pe care le satisface — R16, R18, R19, R28, intervalele lui `temei` și `pers_inreg` — nu
sunt scrise nicăieri public. Cine implementează generatorul pornește de aici, nu de la zero.

Structura, regulile și ce a mai rămas de decis: `docs/validare-oficiala.md`, secțiunea
„Recunoaștere 2026-08-07 — D301".

**Nu e o schemă XSD** și nu se folosește în validarea automată — de aceea stă separat de
`schemas/eTransport/`, care e schema oficială folosită de poartă.
