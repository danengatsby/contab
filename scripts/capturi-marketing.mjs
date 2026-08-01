// Capturi de ecran pentru materialele de marketing (vezi PREZENTARE.md, capitolul 12).
//
// DE CE NU SE FAC DE PE CONTUL DEMO PUBLIC: contul demo de pe contabo.space e SCRIIBIL DE ORICINE
// si se reseteaza zilnic. O captura de acolo publica ce a lasat ultimul vizitator — la prima
// incercare, tabloul de bord arata sold negativ, 10 termene depasite si facturi netrimise. Pentru
// marketing ai nevoie de date pe care le controlezi, deci se porneste o instanta IZOLATA cu
// exemplul oficial din ghid.
//
// Reteta completa (Docker, fiindca pe server nu exista chromium — vezi .claude/skills/run-app):
//
//   S=/tmp/capturi
//   export CONTAB_DEV=1 CONTAB_DB_DRIVER=sqlite CONTAB_DB_FILE=$S/cap.json \
//          CONTAB_DATA_DIR=$S/cap-data CONTAB_JSON_MIRROR=0 STRIPE_SECRET_KEY=''
//   node scripts/seed.js                      # firma-exemplu, date pe 2026-06
//   PORT=18099 node server.js &
//   # (optional) portofoliul are nevoie de mai multe firme — vezi PREZENTARE.md 12.6
//   cp scripts/capturi-marketing.mjs $S/ && docker run --rm --network host \
//     -v $S:/w -w /w mcr.microsoft.com/playwright:v1.58.2-noble \
//     sh -c "npm i --no-save playwright@1.58.2 >/dev/null 2>&1 && node capturi-marketing.mjs"
//   fuser -k 18099/tcp && rm -rf $S/cap-data $S/cap.json $S/cap.sqlite
//
// CAPCANE, toate intalnite:
//   - `waitUntil: 'networkidle'` NU se atinge niciodata: aplicatia face poll in fundal. domcontentloaded.
//   - `#loginForm` NU are `button[type=submit]` — formularul se trimite cu Enter.
//   - La prima autentificare se cere schimbarea parolei: primul camp e parola ACTUALA (`admin`).
//   - Selectorul de firma e `#firmaSelect` (nu `#firmaSel`), iar firma activa dupa creari e ULTIMA
//     creata — deci goala. Fara comutare explicita, decontul iese cu toate zerourile.
//   - Grupurile din meniu sunt PLIATE; cardurile de pe „Acasa" duc direct la ecranele din ele.
//   - Luna de lucru e globala: `#prevMonth` o muta inapoi (exemplul are datele pe iunie).
//   - Marcarea unei declaratii ca „depusa" BLOCHEAZA automat perioada, iar bannerul de luna inchisa
//     acopera jumatate din ecran. Se deblocheaza cu POST /api/period-lock { lockedUntil: '' }.

import { chromium } from 'playwright';

const B = process.env.BASE_URL || 'http://127.0.0.1:18099';
const PW = process.env.CAPTURI_PW || 'ParolaDemo2026x';

const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const curat = async () => {
  await pg.evaluate(() => document.querySelectorAll('#welcomeOverlay,.toast,#fwWizard,.op-wizard').forEach((e) => e.remove()));
  await pg.waitForTimeout(400);
};

await pg.goto(B + '/', { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('#loginForm [name=username]', { state: 'visible' });
await pg.fill('#loginForm [name=username]', 'admin');
await pg.fill('#loginForm [name=password]', PW);
await pg.press('#loginForm [name=password]', 'Enter');
await pg.waitForTimeout(2500);

// prima autentificare pe o baza proaspata cere schimbarea parolei implicite
const parole = await pg.$$('input[type=password]:visible');
if (parole.length >= 3) {
  await parole[0].fill('admin');            // parola ACTUALA, nu cea noua
  await parole[1].fill(PW);
  await parole[2].fill(PW);
  await parole[2].press('Enter');
  await pg.waitForTimeout(3000);
}
await curat();

// firma cu date, nu ultima creata
await pg.selectOption('#firmaSelect', { index: 0 });
await pg.waitForTimeout(1500);

const capt = async (nume, pasi) => {
  try {
    await pasi();
    await curat();
    await pg.screenshot({ path: nume + '.png' });
    console.log('  ' + nume + '.png');
  } catch (e) { console.log('  ' + nume + ': NEATINS — ' + e.message.split('\n')[0].slice(0, 60)); }
};

const acasa = async () => { await pg.click('text=Acasă'); await pg.waitForTimeout(1400); };

await capt('fb-1-acasa', acasa);
await capt('fb-2-portofoliu', async () => { await pg.click('text=Portofoliu'); await pg.waitForTimeout(2200); });
await capt('fb-3-document', async () => { await pg.click('text=Adaugă document primit'); await pg.waitForTimeout(1800); });
await capt('fb-4-tva', async () => {
  await acasa();
  await pg.click('#prevMonth'); await pg.waitForTimeout(800);   // august -> iulie
  await pg.click('#prevMonth'); await pg.waitForTimeout(1400);  // iulie  -> iunie (datele exemplului)
  await pg.click('text=Decont TVA'); await pg.waitForTimeout(2200);
});
await capt('fb-5-balanta', async () => { await acasa(); await pg.click('text=Vezi balanța'); await pg.waitForTimeout(2000); });

await b.close();
