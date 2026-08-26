# Contractele de verificare

Comenzile au scopuri diferite și stabile:

- `npm test` rulează toate testele funcționale locale, inclusiv sintaxa, modulele, frontendul pur, persistența SQLite și integrarea HTTP. Nu cere rețea și nu include ESLint.
- `npm run lint` rulează analiza statică ESLint. Cere dependențele de dezvoltare.
- `npm run verify` este poarta pentru o schimbare locală: rulează integral atât `npm test`, cât și `npm run lint`, chiar dacă prima parte eșuează.
- `npm run verify:startup` este controlul rapid de sintaxă folosit de `prestart`. Nu rulează suita completă și nu cere ESLint, astfel încât instalările de producție cu `npm ci --omit=dev` pot porni.

CI păstrează testele și lint-ul în joburi separate, ca verdictul și cauza să fie vizibile distinct. Echivalentul local al verdictului lor combinat este `npm run verify`.

Auditul de dependențe și testele PostgreSQL/browser au comenzi separate deoarece cer rețea sau infrastructură:

- `npm audit --audit-level=high`
- `npm run test-pg`
- `npm run e2e-izolat`

Pentru poarta browser UX (fără scenariile fiscale/restore ale suitei extinse) se poate rula
`E2E_UX_ONLY=1 npm run e2e-izolat`. Launcherul folosește tot o bază și un director de date temporare.
