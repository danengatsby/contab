// ─────────────────────────────────────────────────────────────────────────────
//  FILMAREA videoului de prezentare — scenariul e in docs/scenariu-video-prezentare.md,
//  iar textul rostit in scripts/naratiune-video.json (o singura sursa pentru voce si pentru doc).
//
//  Fiecare scena tine EXACT cat vocea ei: actiunile se executa, apoi se asteapta restul din
//  `durate.json`. La final se scrie `timeline.json` — offsetul REAL al fiecarei scene in
//  inregistrare — dupa care scripts/video-montaj.mjs aseaza sunetul la locul lui. Fara timeline,
//  sincronizarea ar fi o presupunere.
//
//  RETETA COMPLETA (instanta IZOLATA cu exemplul din ghid, NU demoul public — vezi antetul lui
//  scripts/capturi-marketing.mjs pentru motiv):
//
//   1. VOCEA (pe gazda, o data): piper + vocea romaneasca ro_RO-mihai-medium.
//        curl -L -o piper.tgz https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
//        tar xzf piper.tgz
//        curl -L -o ro.onnx      "https://huggingface.co/rhasspy/piper-voices/resolve/main/ro/ro_RO/mihai/medium/ro_RO-mihai-medium.onnx?download=true"
//        curl -L -o ro.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/ro/ro_RO/mihai/medium/ro_RO-mihai-medium.onnx.json?download=true"
//        # pentru fiecare scena din scripts/naratiune-video.json:
//        #   echo "<text>" | LD_LIBRARY_PATH=./piper ./piper/piper --model ro.onnx --output_file wav/<id>.wav
//        # apoi durate.json = [{ id, wav, durata }] (durata se citeste din antetul WAV)
//
//   2. INSTANTA:
//        S=/tmp/video
//        export CONTAB_DEV=1 CONTAB_DB_DRIVER=sqlite CONTAB_DB_FILE=$S/vid.json \
//               CONTAB_DATA_DIR=$S/vid-data CONTAB_JSON_MIRROR=0 STRIPE_SECRET_KEY=''
//        node scripts/seed.js                      # firma-exemplu, date pe 2026-06
//        PORT=18099 HOST=127.0.0.1 CONTAB_HIBP=0 node server.js &
//        # parola contului admin se schimba o data (seed-ul porneste cu admin/admin):
//        #   POST /api/change-password { oldPassword: 'admin', newPassword: <VIDEO_PW> }
//
//   3. FILMAREA (Docker, fiindca pe server nu exista Chromium):
//        mkdir -p $S/out && cp scripts/video-prezentare.mjs $S/film.mjs
//        cp -r <wav+durate.json> $S/tts
//        docker run --rm --network host -v $S:/w -w /w mcr.microsoft.com/playwright:v1.58.2-noble \
//          sh -c "npm i --no-save playwright@1.58.2 >/dev/null 2>&1 && node film.mjs"
//
//   4. MONTAJUL: cp scripts/video-montaj.mjs $S/mux.mjs, apoi acelasi container cu
//      `npm i --no-save ffmpeg-static` (pe gazda nu exista ffmpeg). Vezi antetul acelui fisier.
//
//  ESECURI TACUTE, toate intalnite aici si toate inchise mai jos:
//    1. CSP-ul aplicatiei (`style-src 'self'`) BLOCHEAZA <style>-ul injectat pentru cartoane si
//       cursor — prima inregistrare a iesit fara ele, fara nicio eroare. De aici `bypassCSP`.
//    2. Cartonul de titlu ramane in DOM intre scene (transparent) si, fara `pointer-events:none`,
//       INGHITE clicurile: formularul nu se mai deschidea, iar pasii raportau tot „reusit".
//    3. Clicul DOM pe a doua intrare a unui grup deschis pica cu „Element is not visible" dupa ce
//       pagina e derulata; navigarea se face prin `window.goTab`, cu cursorul plimbat pe intrare.
//    4. `waitForSelector('#registerOverlay.hidden')` cu starea implicita „visible" NU se poate
//       implini niciodata (un element .hidden nu e vizibil): inscrierea REUSEA, iar filmarea
//       raporta esec. Se cere explicit `{ state: 'hidden' }`.
//    5. CUI-ul inventat pica la cifra de control (src/identitate.js) — serverul raspunde 400, iar
//       filmarea mergea mai departe pe formularul ramas pe ecran.
//    6. „Iesi" cheama `location.reload()`, care se ciocnea cu navigarea scriptului si lasa sesiunea
//       in aer — de doua ori filmul a ramas pe contul de proba, tacut.
//  De aceea fiecare scena isi raporteaza starea, iar rezultatul se verifica pe CONTACTUL de imagini
//  produs de montaj (un cadru la fiecare scena), nu pe log.
// ─────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18099';
const PW = process.env.VIDEO_PW || 'VideoDemo2026x';
const W = 1280; const H = 720;
const DUR = Object.fromEntries(JSON.parse(fs.readFileSync('/w/tts/durate.json', 'utf8')).map((s) => [s.id, s.durata]));

const b = await chromium.launch();
const ctx = await b.newContext({ bypassCSP: true, viewport: { width: W, height: H }, recordVideo: { dir: '/w/out', size: { width: W, height: H } } });
const pg = await ctx.newPage();
const t0 = Date.now();
const clipa = () => (Date.now() - t0) / 1000;
const asteapta = (ms) => pg.waitForTimeout(ms);
const jurnal = []; const timeline = [];

/** O scena tine EXACT cat vocea ei: actiunile se executa, apoi se asteapta restul. */
async function scena(id, fn) {
  const start = clipa();
  timeline.push({ id, start: Number(start.toFixed(2)) });
  try { await unelte(); await fn(); jurnal.push('  ✓ ' + id); }
  catch (e) { jurnal.push('  ✗ ' + id + ' — ' + String(e.message).split('\n')[0].slice(0, 80)); }
  const ramas = (DUR[id] || 8) + 0.7 - (clipa() - start);
  if (ramas > 0) await asteapta(ramas * 1000);
}

// ── uneltele de filmare (se pierd la fiecare navigare, deci se reinjecteaza) ──
async function unelte() {
  await pg.evaluate(() => {
    if (document.querySelector('#__cur')) return;
    const s = document.createElement('style');
    s.textContent = `
      #__cur{position:fixed;z-index:2147483646;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;
        background:rgba(240,193,75,.28);border:2px solid #f0c14b;pointer-events:none;left:50%;top:55%;
        transition:left .55s cubic-bezier(.4,0,.2,1),top .55s cubic-bezier(.4,0,.2,1),transform .18s}
      #__cur.apasa{transform:scale(.55);background:rgba(240,193,75,.6)}
      .__tinta{outline:3px solid #f0c14b !important;outline-offset:2px;border-radius:8px}
      #__card{pointer-events:none;position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;
        align-items:center;justify-content:center;gap:14px;background:#14120f;color:#f6f1e7;opacity:0;
        transition:opacity .4s;font-family:Georgia,'Times New Roman',serif;text-align:center;padding:0 8%}
      #__card.on{opacity:1}
      #__card b{white-space:pre-line;font-size:50px;line-height:1.15;letter-spacing:-.5px}
      #__card span{white-space:pre-line;font-size:22px;color:#c9bfae;font-family:system-ui,sans-serif;line-height:1.5}
      #__card i{font-size:18px;color:#f0c14b;font-style:normal;letter-spacing:2px;text-transform:uppercase}`;
    document.head.appendChild(s);
    const c = document.createElement('div'); c.id = '__cur'; document.body.appendChild(c);
    const k = document.createElement('div'); k.id = '__card'; k.innerHTML = '<i></i><b></b><span></span>'; document.body.appendChild(k);
    window.__card = (sus, titlu, jos) => {
      const k2 = document.querySelector('#__card');
      k2.querySelector('i').textContent = sus || ''; k2.querySelector('b').textContent = titlu || '';
      k2.querySelector('span').textContent = jos || ''; k2.classList.add('on');
    };
    window.__cardOff = () => document.querySelector('#__card').classList.remove('on');
    window.__cur = (x, y) => { const e = document.querySelector('#__cur'); e.style.left = x + 'px'; e.style.top = y + 'px'; };
    window.__apasa = () => { const e = document.querySelector('#__cur'); e.classList.add('apasa'); setTimeout(() => e.classList.remove('apasa'), 220); };
  });
}
const card = async (sus, titlu, jos, ms = 1800) => {
  await pg.evaluate(([a, b2, c]) => window.__card(a, b2, c), [sus, titlu, jos]);
  await asteapta(ms);
  await pg.evaluate(() => window.__cardOff());
  await asteapta(500);
};
const cursorLa = async (el) => {
  const box = await el.boundingBox().catch(() => null);
  if (!box) return null;
  await pg.evaluate(([x, y]) => window.__cur(x, y), [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]);
  await asteapta(550);
  return box;
};
const clic = async (sel, { dupa = 800 } = {}) => {
  const el = pg.locator(sel).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const box = await cursorLa(el);
  if (box) { await el.evaluate((e) => e.classList.add('__tinta')).catch(() => {}); await asteapta(280); }
  await pg.evaluate(() => window.__apasa());
  await el.click({ force: true });
  if (box) await el.evaluate((e) => e.classList.remove('__tinta')).catch(() => {});
  await asteapta(dupa);
};
/** Clic care NU arunca daca tinta lipseste sau e ascunsa — pentru pasii optionali (tur, overlay). */
const clicDaca = async (sel, opt) => {
  const el = pg.locator(sel).first();
  if (!(await el.count())) return false;
  if (!(await el.isVisible().catch(() => false))) return false;
  await clic(sel, opt); return true;
};
/** Nicio scena nu incepe cu un modal ramas deschis de la cea dinainte: ar inghiti clicurile. */
const inchideModale = () => pg.evaluate(() => {
  ['#welcomeOverlay', '#tourCard', '#pricingOverlay', '#faqOverlay', '#registerOverlay']
    .forEach((s2) => { const e = document.querySelector(s2); if (e) e.classList.add('hidden'); });
  document.querySelectorAll('.toast').forEach((e) => e.remove());
});
const intra = async (tab, dupa = 1500) => {
  const el = pg.locator('#tabs button[data-tab="' + tab + '"]').first();
  const box = await cursorLa(el);
  if (box) { await el.evaluate((e) => e.classList.add('__tinta')).catch(() => {}); await asteapta(260); }
  await pg.evaluate(() => window.__apasa());
  await pg.evaluate((t) => window.goTab(t), tab);
  if (box) await el.evaluate((e) => e.classList.remove('__tinta')).catch(() => {});
  await asteapta(dupa);
};
const meniu = async (grup, tab, dupa = 1500) => {
  const lbl = pg.locator('#tabs .navlabel', { hasText: grup }).first();
  const deschis = await lbl.evaluate((e) => e.closest('.navgroup').classList.contains('open')).catch(() => false);
  if (!deschis) await clic('#tabs .navlabel:has-text("' + grup + '")', { dupa: 800 });
  await intra(tab, dupa);
};
const curata = () => pg.evaluate(() => document.querySelectorAll('.toast').forEach((e) => e.remove()));
const derulare = async (px, ms = 1200) => { await pg.evaluate((p) => window.scrollTo({ top: p, behavior: 'smooth' }), px); await asteapta(ms); };
const scrie = async (sel, txt, delay = 45) => {
  const el = pg.locator(sel).first();
  if (!(await el.count())) return;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await cursorLa(el);
  await el.click({ force: true });
  await el.fill('');
  await el.type(txt, { delay });
  await asteapta(200);
};

// ═══ S01 · pagina publica de prezentare ═══════════════════════════════════
await pg.goto(BASE + '/prezentare.html', { waitUntil: 'domcontentloaded' });
await asteapta(1200); await unelte();
await scena('s01-prezentare', async () => {
  await card('Contabo', 'Contabilitatea firmei tale,\nde la poză la declarație', 'contabilitate românească · partidă dublă · parametri fiscali 2026', 2600);
  await derulare(0, 900);
  await derulare(700, 2000);
  await derulare(1500, 2000);
  await derulare(2400, 2000);
});

// ═══ S02 · preturile ══════════════════════════════════════════════════════
await scena('s02-preturi', async () => {
  await pg.evaluate(() => document.querySelector('#preturi').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await asteapta(2600);
  await derulare(await pg.evaluate(() => document.querySelector('#preturi').offsetTop + 260), 2400);
  await derulare(await pg.evaluate(() => document.querySelector('#onest').offsetTop - 60), 2400);
});

// ═══ S03 · crearea contului ═══════════════════════════════════════════════
await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('#registerBtn', { state: 'visible' });
await asteapta(600); await unelte();
await scena('s03-cont', async () => {
  await clic('#registerBtn', { dupa: 1200 });
  await scrie('#registerForm [name="nume"]', 'S.C. FLORI SI FRUNZE S.R.L.');
  // CUI cu cifra de control VALIDA: serverul o verifica (src/identitate.js), iar un CUI inventat
  // opreste inscrierea cu 400 — la o filmare, tacut: pasii urmatori merg mai departe pe formularul
  // ramas pe ecran, iar naratiunea promite un cont care nu s-a creat.
  await scrie('#registerForm [name="cui"]', 'RO4512372');
  await scrie('#registerForm [name="username"]', 'maria');
  await scrie('#registerForm [name="password"]', 'ParolaMea2026!', 30);
  await scrie('#registerForm [name="email"]', 'maria@exemplu.ro', 30);
  await clic('#regSubmit', { dupa: 1200 });
  // Daca inscrierea NU a reusit, scena trebuie sa PICE zgomotos: altfel filmarea merge mai departe
  // pe formularul ramas pe ecran si abia la vizionare se vede ca nu s-a creat niciun cont.
  // `state: 'hidden'` — NU `#registerOverlay.hidden` cu starea implicita „visible": un element cu
  // clasa .hidden nu e vizibil niciodata, deci asteptarea aceea nu se putea implini nici cand
  // inscrierea REUSEA. Exact ce s-a intamplat: contul se crea, iar filmarea raporta esec.
  await pg.waitForSelector('#registerOverlay', { state: 'hidden', timeout: 15000 });
  await asteapta(1200);
});

// ═══ S04 · prima intrare: bun venit + turul meniului ══════════════════════
await unelte();
await scena('s04-primaintrare', async () => {
  await unelte();
  // Ecranul de bun-venit apare o singura data per cont si per browser, iar momentul lui depinde de
  // cat dureaza initializarea — la filmare a picat de doua ori langa taietura si scena promitea ce
  // nu se vedea. Se arata DETERMINIST: e componenta reala a aplicatiei, doar declansata la timp.
  await pg.evaluate(() => { const w = document.querySelector('#welcomeOverlay'); if (w) w.classList.remove('hidden'); });
  await asteapta(3000);
  await clicDaca('#welcomeStart', { dupa: 1500 });
  for (let i = 0; i < 4; i++) { if (!(await clicDaca('#tourNext', { dupa: 1600 }))) break; }
  await clicDaca('#tourSkip', { dupa: 600 });
  await inchideModale();
});

// ═══ S05 · intrarea pe firma cu date ══════════════════════════════════════
await scena('s05-comutare', async () => {
  await pg.evaluate(() => { try { localStorage.setItem('contab_workmonth', '2026-06'); localStorage.setItem('contab_welcomed_admin', '1'); localStorage.setItem('contab_tour_v1_admin', '1'); } catch (e) {} });
  await inchideModale();
  // Cursorul apasa „Iesi" ca in realitate, dar delogarea se face prin API si o incarcare curata:
  // butonul real cheama `location.reload()`, care se ciocnea cu navigarea scriptului si lasa
  // sesiunea in aer — de doua ori filmarea a ramas pe contul de proba, tacut.
  const iesi = pg.locator('#logoutBtn').first();
  await cursorLa(iesi);
  await iesi.evaluate((e) => e.classList.add('__tinta')).catch(() => {});
  await asteapta(300);
  await pg.evaluate(() => window.__apasa());
  await pg.evaluate(async () => { const m = await import('/core.js'); await window.fetch('/api/logout', m.withCsrf({ method: 'POST' })); });
  await asteapta(600);
  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#loginForm [name=username]', { state: 'visible', timeout: 20000 });
  await unelte();
  await scrie('#loginForm [name="username"]', 'admin', 60);
  await scrie('#loginForm [name="password"]', PW, 30);
  await pg.press('#loginForm [name=password]', 'Enter');
  await asteapta(3000);
  await unelte(); await curata();
});

// ═══ S05b · portofoliul de firme ══════════════════════════════════════════
await scena('s05b-portofoliu', async () => {
  await intra('portofoliu', 1800);
  await derulare(240, 1800);
  await derulare(0, 1200);
});

// ═══ S06 · ghidul ═════════════════════════════════════════════════════════
await scena('s06-ghid', async () => {
  await intra('ghid', 1500);
  await curata();
  await derulare(500, 1800); await derulare(1400, 1800); await derulare(2400, 1600);
});

// ═══ S07 · acasa ══════════════════════════════════════════════════════════
await scena('s07-acasa', async () => {
  await intra('dashboard', 1800);
  await curata();
  await derulare(0, 1000); await derulare(420, 2000); await derulare(950, 1600); await derulare(0, 900);
});

// ═══ S07b · arhiva pe luni (dosarul lunii) ════════════════════════════════
await scena('s07b-arhiva', async () => {
  await meniu('Rapoarte & analize', 'arhiva', 1800);
  await derulare(260, 1800);
  await derulare(0, 1000);
});

// ═══ S08 · documentul primit ══════════════════════════════════════════════
await scena('s08-document', async () => {
  await card('Pasul 1', 'Documentele', 'ce intră și ce iese din firmă', 1700);
  await meniu('Documente', 'documente', 1600);
  await curata();
  await derulare(240, 1400);
  await clic('#manualBtn', { dupa: 1200 });
  await clic('#tipSelect', { dupa: 400 });
  const v = await pg.evaluate(() => { const o = [...document.querySelectorAll('#tipSelect option')].find((x) => /cumparare marfuri/i.test(x.textContent)); return o ? o.value : ''; });
  if (v) await pg.selectOption('#tipSelect', v);
  await asteapta(1600);
});

// ═══ S09 · previzualizarea + salvarea ═════════════════════════════════════
await scena('s09-previzualizare', async () => {
  await scrie('#dynFields [name="data"]', '2026-06-18', 35);
  await scrie('#dynFields [name="partener"]', 'ALFA DISTRIBUTIE SRL', 35);
  await scrie('#dynFields [name="cuiPartener"]', '11223342', 35);
  await scrie('#dynFields [name="document"]', 'FF 2214', 45);
  await scrie('#dynFields [name="baza"]', '1000', 60);
  await pg.locator('#dynFields [name="baza"]').first().press('Tab').catch(() => {});
  await asteapta(1800);
  await derulare(600, 1500);
});
await scena('s09b-controale', async () => {
  await clic('#entryForm button[type="submit"]', { dupa: 2200 });
  await curata();
  await intra('intrate', 2000);
  await derulare(260, 1600);
  await derulare(700, 1800);
});

// ═══ S10 · factura emisa ══════════════════════════════════════════════════
await scena('s10-emite', async () => {
  await intra('emite', 1800);
  await curata();
  await derulare(280, 1800); await derulare(700, 1800); await derulare(0, 900);
});

// ═══ S11 · banii ══════════════════════════════════════════════════════════
await scena('s11-bani', async () => {
  await card('Pasul 2', 'Banii', 'încasări, plăți și extrasul bancar', 1600);
  await meniu('Bani', 'cashbook', 1800);
  await curata(); await derulare(260, 1600);
  await intra('reconciliere', 1800);
  await derulare(300, 1500);
});

// ═══ S12 · stocuri ════════════════════════════════════════════════════════
await scena('s12-stocuri', async () => {
  await card('Pasul 3', 'Ce mișcă în fiecare lună', 'stocuri · salarii · amortizare', 1700);
  await meniu('Stocuri', 'stocuri', 1800);
  await curata(); await derulare(320, 1800); await derulare(900, 1800);
});

// ═══ S13 · salarii ════════════════════════════════════════════════════════
await scena('s13-salarii', async () => {
  await meniu('Salarii', 'salarizare', 2000);
  await curata(); await derulare(300, 1800); await derulare(700, 1800);
  await intra('angajati', 1800);
  await derulare(300, 1500);
});

// ═══ S14 · mijloace fixe + leasing ════════════════════════════════════════
await scena('s14-mijloace', async () => {
  await meniu('Mijloace fixe', 'mijloace', 2000);
  await curata(); await derulare(260, 1600);
  await intra('leasing', 1800);
  await derulare(320, 1500);
});

// ═══ S15 · registrele ═════════════════════════════════════════════════════
await scena('s15-registre', async () => {
  await card('Pasul 4', 'Registrele se scriu singure', 'jurnal · cartea mare · balanță', 1700);
  await meniu('Registre', 'jurnal', 1800);
  await curata(); await derulare(280, 1500);
  await intra('carte', 1600);
  await intra('balanta', 1800);
  await derulare(420, 1800);
});

// ═══ S16 · inchiderea lunii ═══════════════════════════════════════════════
await scena('s16-inchidere', async () => {
  await card('Pasul 5', 'Închiderea lunii', 'starea fiecărui pas se calculează din date', 1800);
  await meniu('Închideri', 'inchideri', 2200);
  await curata();
  await derulare(280, 1700); await derulare(650, 1700); await derulare(1050, 1700); await derulare(1400, 1700);
});

// ═══ S16b · inchiderea anului ═════════════════════════════════════════════
await scena('s16b-an', async () => {
  await meniu('Închideri', 'inchidere-an', 1800);
  await derulare(300, 2000);
  await derulare(620, 1800);
});

// ═══ S16c · registrul de evidenta fiscala (drumul spre D101) ══════════════
await scena('s16c-regfiscal', async () => {
  await meniu('Taxe & declarații', 'regfiscal', 1800);
  await derulare(280, 2200);
  await derulare(0, 1200);
});

// ═══ S17 · TVA ════════════════════════════════════════════════════════════
await scena('s17-tva', async () => {
  await card('Pasul 6', 'Taxele și declarațiile', 'D300 · D394 · D112 · SAF-T', 1600);
  await meniu('Taxe', 'tva', 2000);
  await curata(); await derulare(320, 1600);
});

// ═══ S17b · decontul precompletat (e-TVA) ═════════════════════════════════
await scena('s17b-etva', async () => {
  await pg.evaluate(() => { const c = document.querySelector('#etvaPrecompletatCard'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  await asteapta(2400);
  await cursorLa(pg.locator('#etvaReconBtn').first());
  await asteapta(1600);
});

// ═══ S18 · declaratii + SAF-T + SPV ═══════════════════════════════════════
await scena('s18-declaratii', async () => {
  await intra('livrabile', 2200);
  await curata(); await derulare(300, 1500); await derulare(800, 1500);
  await intra('saft', 1700);
  await derulare(300, 1600);
  await intra('spv', 1800);
});

// ═══ S18b · SAF-T (D406) ══════════════════════════════════════════════════
await scena('s18b-saft', async () => {
  await meniu('Taxe & declarații', 'saft', 1800);
  await derulare(260, 2000);
  await derulare(0, 1200);
});

// ═══ S19 · rapoarte ═══════════════════════════════════════════════════════
await scena('s19-rapoarte', async () => {
  await card('Pasul 7', 'Cum stă firma', 'bilanț · profit și pierdere · scadențar', 1600);
  await meniu('Rapoarte', 'situatii', 2200);
  await curata(); await derulare(340, 1800);
  await intra('anexe', 1800);
  await derulare(300, 1500);
  await intra('analitic', 1600);
});

// ═══ S19b · scadentarul clienti & furnizori ═══════════════════════════════
await scena('s19b-analitic', async () => {
  await meniu('Rapoarte & analize', 'analitic', 1800);
  await derulare(300, 2200);
  await derulare(640, 1800);
});

// ═══ S20 · setarile ═══════════════════════════════════════════════════════
await scena('s20-setari', async () => {
  await card('Configurare', 'Setările', 'ce se face o dată și se atinge rar', 1600);
  await meniu('Setări', 'setari', 1800);
  await curata(); await derulare(300, 1400);
  await intra('cont', 1300);
  await intra('acces', 1300);
  await intra('date', 1300);
  await intra('conexiuni', 1300);
  await intra('pachetwin', 1400);
  await intra('video', 1600);
});

// ═══ S20b · jurnalul de audit ═════════════════════════════════════════════
await scena('s20b-audit', async () => {
  await meniu('Setări', 'audit', 1800);
  await derulare(260, 2000);
  await derulare(0, 1000);
});

// ═══ S21 · increderea ═════════════════════════════════════════════════════
await scena('s21-incredere', async () => {
  await intra('date', 1800);
  await curata(); await derulare(300, 2000); await derulare(700, 2000);
  await card('De ce poți avea încredere', 'Validat cu validatorul\npublicat de ANAF',
    'peste 4.600 de verificări automate la fiecare versiune\nbackup zilnic, cu copie în afara serverului', 6000);
});

// ═══ S22 · limitele, cinstit ══════════════════════════════════════════════
await scena('s22-limite', async () => {
  await card('Ce rămâne la tine', 'Cinstit, până la capăt',
    'depunerea în SPV o faci tu, cu certificatul tău digital\nvalidarea finală, cu DUKIntegrator\ncasa de marcat rămâne obligatorie separat\nbilanțul cere semnătura unui contabil autorizat', 18000);
});

// ═══ S23 · final ══════════════════════════════════════════════════════════
await scena('s23-final', async () => {
  await card('30 de zile gratuit, fără card', 'contabo.space', 'aduci documentele — Contabo face contabilitatea', 9000);
});

fs.writeFileSync('/w/out/timeline.json', JSON.stringify({ scene: timeline, total: clipa() }, null, 1));
console.log(jurnal.join('\n'));
console.log('durata inregistrarii: %s s', clipa().toFixed(1));
await ctx.close();
await b.close();
