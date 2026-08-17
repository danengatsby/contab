// Capturi de ecran pentru materialele de marketing (vezi PREZENTARE.md, capitolul 12).
//
// DE CE NU SE FAC DE PE CONTUL DEMO PUBLIC: contul demo de pe contabo.space e SCRIIBIL DE ORICINE
// si se reseteaza zilnic. O captura de acolo publica ce a lasat ultimul vizitator — la prima
// incercare, tabloul de bord arata sold negativ, 10 termene depasite si facturi netrimise. Pentru
// marketing ai nevoie de date pe care le controlezi, deci se porneste o instanta IZOLATA cu
// exemplul oficial din ghid.
//
// Rulare completă: `npm run capturi-marketing`. Launcherul pornește baza și
// serverul temporar, pregătește portofoliul, rulează acest browser și publică
// atomic aceleași fișiere în marketing/capturi și public/materiale.
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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const B = process.env.BASE_URL || 'http://127.0.0.1:18099';
const INITIAL_PW = process.env.CAPTURI_INITIAL_PW || 'admin';
const PW = process.env.CAPTURI_PW || 'ParolaDemo2026x!';
const OUT = process.env.CAPTURI_OUTPUT || process.cwd();
fs.mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const curat = async () => {
  await pg.evaluate(() => document.querySelectorAll('#welcomeOverlay,.toast,#fwWizard,.op-wizard').forEach((e) => e.remove()));
  await pg.waitForTimeout(400);
};
const pozitioneazaMeniu = async () => {
  await pg.evaluate(() => {
    const meniu = document.querySelector('#tabs');
    const activ = meniu?.querySelector('button[data-tab].active');
    const grup = activ?.closest('.navgroup');
    if (!meniu) return;
    if (!grup) {
      meniu.scrollTop = 0;
      return;
    }
    const top = meniu.scrollTop + grup.getBoundingClientRect().top - meniu.getBoundingClientRect().top;
    meniu.scrollTop = Math.max(0, top - 4);
  });
  await pg.waitForTimeout(160);
};

await pg.goto(B + '/', { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('#loginForm [name=username]', { state: 'visible' });
await pg.fill('#loginForm [name=username]', 'admin');
await pg.fill('#loginForm [name=password]', INITIAL_PW);
// DOMContentLoaded poate veni înainte ca modulul authui.js să fi legat evenimentul formularului.
// O pauză scurtă + click pe acțiunea explicită evită trimiterea nativă prematură a formularului.
await pg.waitForTimeout(900);
await pg.click('#loginForm button.primary');
await pg.waitForTimeout(2500);

// prima autentificare pe o baza proaspata cere schimbarea parolei implicite. Selectoarele sunt
// scopate pe overlay: pagina contine si formularele ascunse de login/admin, deci numararea tuturor
// campurilor de parola poate da un rezultat corect din motivul gresit.
if (await pg.locator('#forcePwOverlay').isVisible()) {
  await pg.fill('#forcePwForm [name=oldPassword]', 'admin');
  await pg.fill('#forcePwForm [name=newPassword]', PW);
  await pg.fill('#forcePwForm [name=newPassword2]', PW);
  await pg.click('#forcePwForm button[type=submit]');
  await pg.waitForTimeout(3000);
  if (await pg.locator('#forcePwOverlay').isVisible()) {
    throw new Error('Schimbarea parolei inițiale a eșuat: ' + await pg.locator('#forcePwErr').textContent());
  }
}
await curat();

// firma cu date, nu ultima creata
await pg.waitForFunction(() => document.querySelectorAll('#firmaSelect option').length > 0);
await pg.selectOption('#firmaSelect', { index: 0 });
await pg.waitForTimeout(1500);

const generate = [];
const capt = async (nume, pasi) => {
  await pasi();
  await curat();
  await pozitioneazaMeniu();
  await pg.screenshot({ path: path.join(OUT, nume + '.png') });
  await pg.screenshot({ path: path.join(OUT, nume + '.jpg'), type: 'jpeg', quality: 88 });
  generate.push(nume);
  console.log('  ' + nume + '.png / .jpg');
};

const tab = async (nume, asteptare = 1600) => {
  await pg.evaluate((n) => window.goTab(n), nume);
  await pg.waitForTimeout(asteptare);
};
const acasa = async () => {
  await tab('dashboard', 1400);
  // Schimbarea obligatorie a parolei trece prin Setări și lasă acel acordeon
  // deschis. Acasă trebuie fotografiat în starea normală de început de zi:
  // grupul de lucru Documente & facturi, același pe care aplicația îl deschide
  // la o pornire fără intermezzo-ul de securitate.
  await pg.evaluate(() => {
    const grup = document.querySelector('#tabs .navgroup');
    if (grup && !grup.classList.contains('open')) grup.querySelector('.navlabel')?.click();
    const meniu = document.querySelector('#tabs');
    if (meniu) meniu.scrollTop = 0;
  });
  await pg.waitForTimeout(300);
};

await capt('fb-1-acasa', acasa);
let portfolioMeta = null;
await capt('fb-2-portofoliu', async () => {
  await tab('portofoliu', 2200);
  portfolioMeta = await pg.evaluate(async () => {
    const luna = document.querySelector('#portofoliuLuna').value;
    const an = document.querySelector('#portofoliuAn').value;
    const period = an + '-' + String(luna).padStart(2, '0');
    const response = await fetch('/api/portfolio?period=' + period);
    return response.json();
  });
  if (!portfolioMeta || portfolioMeta.firms.length !== 7 || portfolioMeta.conformitate < 70
    || portfolioMeta.conformitate > 90 || portfolioMeta.tot.restante !== 0) {
    throw new Error('Portofoliul capturii nu este fixture-ul realist așteptat.');
  }
});
await capt('fb-3-document', async () => tab('documente', 1800));
await capt('fb-4-tva', async () => {
  await acasa();
  await pg.click('#prevMonth'); await pg.waitForTimeout(800);   // august -> iulie
  await pg.click('#prevMonth'); await pg.waitForTimeout(1400);  // iulie  -> iunie (datele exemplului)
  await tab('tva', 2200);
});
await capt('fb-5-balanta', async () => tab('balanta', 2000));

const surse = [
  'index.html', 'styles.css', 'u.css', 'erp.css', 'design-system.css', 'erp.js',
  'dashboard.js', 'docflow.js', 'livrabile.js', 'rapoarte.js', 'sw.js',
];
const hash = crypto.createHash('sha256');
let sw = '';
for (const sursa of surse) {
  const response = await fetch(B + '/' + sursa);
  if (!response.ok) throw new Error('Nu pot amprenta /' + sursa + ': HTTP ' + response.status);
  const continut = await response.text();
  hash.update(sursa); hash.update('\0'); hash.update(continut); hash.update('\0');
  if (sursa === 'sw.js') sw = continut;
}
const cache = (sw.match(/const CACHE = ['"]([^'"]+)/) || [])[1] || '';
const manifest = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  uiCache: cache,
  sourceFingerprint: hash.digest('hex'),
  sources: surse,
  viewport: { css: [1440, 900], pixels: [2880, 1800], deviceScaleFactor: 2 },
  captures: generate.flatMap((nume) => [nume + '.png', nume + '.jpg']),
  portfolio: {
    period: portfolioMeta.period,
    firms: portfolioMeta.firms.length,
    conformity: portfolioMeta.conformitate,
    overdue: portfolioMeta.tot.restante,
  },
};
fs.writeFileSync(path.join(OUT, 'capturi-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('  manifest: ' + cache + ' / ' + manifest.sourceFingerprint.slice(0, 12));

await b.close();
