# Contab — aplicație de contabilitate (ciclul contabil)

Aplicație web care **primește documente primare în PDF** (facturi, chitanțe, NIR-uri,
state de plată…) și **livrează documente în PDF** (registrul-jurnal, cartea mare,
balanța de verificare, contul de profit și pierdere, bilanțul, note contabile),
urmând ciclul contabil românesc:

```
document justificativ → articol contabil → registrul-jurnal → cartea mare
   → balanța de verificare → declarații + situații financiare
```

Totul se bazează pe **partida dublă** (orice operațiune: un cont se debitează, altul se
creditează, cu aceeași sumă) și pe **planul de conturi românesc** (clasele 1–8).

## Pornire rapidă

```bash
npm install
npm start            # porneste pe http://localhost:8080  (sau PORT=3787 npm start)
npm test             # suita completa: lint + verificari de module + verificari HTTP
```

**Cerință Node:** driverul implicit `sqlite` folosește `node:sqlite`, deci cere **Node ≥ 22.13**
(sau 22.5+ pornit cu `--experimental-sqlite`). Pe un Node mai vechi, pornirea eșuează cu un mesaj
clar — folosește atunci `CONTAB_DB_DRIVER=pg` (PostgreSQL) sau `CONTAB_DB_DRIVER=json`, care merg
pe orice Node. Producția rulează pe PostgreSQL. (Declarat și în `package.json` → `engines`.)

Apoi deschide `http://localhost:8080` în browser. Pe prima pornire se creează contul
`admin` / `admin` (ți se cere schimbarea parolei la prima autentificare).

Extragerea cu AI a documentelor e opțională: pune `ANTHROPIC_API_KEY` sau `OPENAI_API_KEY`
în `.env` (vezi [`.env.example`](.env.example)). Fără ea, extragerea cade grațios pe reguli locale.

## Documentație

| Ghid | Conținut |
|------|----------|
| [Rulare, deploy și configurare](docs/rulare.md) | pornire, nginx, systemd, PostgreSQL, variabile de mediu |
| [Fluxul de lucru (cei 5 pași)](docs/flux-de-lucru.md) | de la documentul primar la declarații, pas cu pas |
| [Arhitectură, multi-firmă și utilizatori](docs/arhitectura.md) | structura codului, izolarea pe firmă, autentificare și drepturi |
| [Documente acceptate și aliniere fiscală](docs/documente-fiscal.md) | tipurile de documente și conformitatea cu ghidul profesional |

Alte referințe: [`STRIPE-SETUP.md`](STRIPE-SETUP.md) (abonamente/plăți),
[`scripts/MONITORING.md`](scripts/MONITORING.md) (monitorizare/uptime).
