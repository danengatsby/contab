# Schema oficială RO e-Transport (XSD)

Schema față de care poarta fiscală validează declarațiile e-Transport generate de aplicație.
**Versionată în repo, deliberat** — vezi mai jos de ce.

| Fișier | Versiune | Namespace | Octeți |
|---|---|---|---|
| `schema_ETR_v2_20230126.xsd` | `1.02` | `mfp:anaf:dgti:eTransport:declaratie:v2` | 39.496 |

Sursa: ANAF/MF, secțiunea „Schema XSD" de pe
<https://etransport.mfinante.gov.ro/informatii-tehnice>.

## De ce e în repo (revenire pe o decizie anterioară)

Politica inițială era „schema NU se livrează în repo, s-ar învechi". Motivul era valid pentru o
schemă **neversionată**, dar cade pentru una cu data în nume:

- **Poarta trebuie să fie reproductibilă.** Runnerul de CI e o mașină efemeră: o variabilă de repo
  care conține o *cale* (`/var/lib/contab/schemas/…`) nu indică nimic acolo. Fără schemă în repo,
  jobul `poarta-fiscala` ar ieși `NEVERIFICAT` și ar bloca fiecare PR fiscal.
- **Învechirea nu mai e tăcută.** Numele poartă versiunea; jobul săptămânal `validare-anaf` rulează
  chiar și când codul nostru nu s-a schimbat, iar `docs/validare-oficiala.md` ține jurnalul.
- **Alternativa era mai rea.** Un blob gzip+base64 într-o variabilă de repo nu se poate citi la
  review — la o schimbare de schemă n-ai vedea *ce* s-a schimbat.

## Cum se înlocuiește la o versiune nouă ANAF

```bash
# 1. pune fișierul nou lângă cel vechi (NU-l suprascrie: numele poartă versiunea)
cp ~/Descărcări/schema_ETR_v2_AAAALLZZ.xsd schemas/eTransport/

# 2. rulează poarta forțat și citește erorile ca pe o specificație
sh scripts/poarta-fiscala.sh --intotdeauna

# 3. dacă apar erori, folosește XSD-ul ca ORACOL: sonde XML minime, citește regula din eroare
xmllint --noout --schema schemas/eTransport/schema_ETR_v2_AAAALLZZ.xsd sonda.xml

# 4. șterge versiunea veche, actualizează tabelul din docs/validare-oficiala.md
```

Se ia mereu **cel mai recent** `*.xsd` din director, deci două fișiere simultan înseamnă că se
validează față de cel nou — ține aici o singură versiune, cea în vigoare.

## Ordinea de căutare a schemei

1. `CONTAB_ETRANSPORT_XSD` — cale locală sau URL (`.xsd`/`.zip`), pentru probe punctuale;
2. `schemas/eTransport/*.xsd` — **acest director** (merge peste tot: local, CI, orice clonă);
3. `CONTAB_ETRANSPORT_SCHEMA_DIR` (implicit `/var/lib/contab/schemas`) — depozitul de pe server;
4. altfel `NEVERIFICAT` → poarta blochează. Fără schemă nu există dovadă.
