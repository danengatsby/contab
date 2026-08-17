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
//        node scripts/video-decor.js               # OBLIGATORIU: actorii (patron/patron2/maria)
//        PORT=18099 HOST=127.0.0.1 CONTAB_HIBP=0 node server.js &
//        # parola contului admin se schimba o data (seed-ul porneste cu admin/admin):
//        #   POST /api/change-password { oldPassword: 'admin', newPassword: <VIDEO_PW> }
//
//      Pasul cu DECORUL lipsea din reteta asta si a costat o filmare: `seed.js` face doar
//      firma-exemplu, iar scenele s05–s09 se autentifica drept `patron` si `maria`. Fara ei,
//      `intraCa` asteapta 20 s ca ecranul de login sa dispara, apoi ARUNCA — deci filmarea moare
//      la scena 5, dupa un minut, si abia in log se vede de ce. Decorul se ruleaza DUPA seed si
//      INAINTE de pornirea serverului (scrie direct in baza) si e idempotent.
//
//   3. FILMAREA (Docker, fiindca pe server nu exista Chromium):
//        mkdir -p $S/out && cp scripts/video-prezentare.mjs $S/film.mjs
//        cp -r <wav+durate.json> $S/tts
//        docker run --rm --network host -v $S:/w -w /w mcr.microsoft.com/playwright:v1.58.2-noble \
//          sh -c "npm i --no-save playwright@1.58.2 >/dev/null 2>&1 && xvfb-run -a node film.mjs"
//
//      `xvfb-run` NU e optional si lipsea din reteta asta — a costat o filmare. Browserul se
//      lanseaza HEADED (`headless: false`, mai jos), fiindca inregistrarea video a Playwright pe
//      Chromium headless dadea alt randament al fonturilor; iar headed fara server X moare din
//      prima cu „Missing X server or $DISPLAY", inainte de orice scena.
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

// HEADED, sub xvfb: in headless, `<iframe src="/pdf/...">` ramane un dreptunghi GRI —
// vizualizatorul de PDF al lui Chromium nu porneste. Scena care arata un document PDF ar fi
// filmat un chenar gol, si nimic n-ar fi semnalat-o: pagina se incarca, modalul se deschide,
// scena raporteaza reusita. Se ruleaza cu `xvfb-run -a node film.mjs`.
const b = await chromium.launch({ headless: false });
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

// ═════════════════════════════════════════════════════════════════════════════
//  SCENELE. Ordinea si textul vin din scripts/naratiune-video.json — o singura sursa.
//  Blocul 1 (s03–s09) e NOU si e miezul filmului: patronul ANGAJEAZA un contabil dintre cei
//  inscrisi in aplicatie, contabilul accepta, si abia atunci vede datele. Se filmeaza pe DOUA
//  conturi diferite (patron / maria), fiindca altfel n-ar fi o dovada, ci o afirmatie.
// ═════════════════════════════════════════════════════════════════════════════

/** Autentificare ca un anumit cont, de la zero. Intre blocuri se schimba actorul, deci se iese
 *  complet: o sesiune ramasa ar arata datele omului gresit exact in scena despre acces. */
async function intraCa(user) {
  // Sesiunea se taie de la RADACINA (cookie-uri), nu prin `/api/logout`: ruta aia e POST, iar un
  // GET pe ea intoarce 404 — filmarea continua cu sesiunea veche, adica exact cu datele omului
  // gresit in scena despre acces. Iar ecranul de login se aduce EXPLICIT la vedere: dupa scena cu
  // inscrierea, si `#loginOverlay`, si `#registerOverlay` raman ascunse, si atunci `waitForSelector`
  // asteapta la infinit un camp care exista dar nu se vede.
  await ctx.clearCookies();
  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  // AMBELE ecrane de intampinare se dezarmeaza ÎNAINTE de autentificare, prin chiar cheile pe
  // care le citeste aplicatia. Ascunderea lor dupa login nu ajunge: `init()` se termina mai tarziu
  // si le ridica peste ecran — asa au iesit doua scene intregi acoperite, fara ca filmarea sa
  // raporteze ceva, fiindca actiunile lor chiar reusisera dedesubt.
  //
  // Turul TREBUIE dezarmat impreuna cu bun-venitul, nu separat: `maybeTour` porneste turul DOAR
  // daca bun-venitul e deja ascuns (`app.js`). Dezarmandu-l doar pe primul, l-am pornit pe al
  // doilea — acelasi defect, alt card, si a trebuit filmat de doua ori ca sa se vada.
  await pg.evaluate((u) => {
    try {
      localStorage.setItem('contab_welcomed_' + u, '1');
      localStorage.setItem('contab_tour_v1_' + u, '1');
      // luna de lucru se pune INAINTE de autentificare, ca aplicatia sa porneasca direct pe ea:
      // `workMonth()` citeste cheia asta la fiecare apel, deci nu mai e nevoie de nicio comutare
      // pe camera. Fara ea, fiecare schimbare de actor readucea filmul pe luna curenta, goala.
      localStorage.setItem('contab_workmonth', '2026-06');
    } catch (e) { /* privat */ }
  }, user);
  await asteapta(900);
  await pg.evaluate(() => {
    const r = document.querySelector('#registerOverlay'); if (r) r.classList.add('hidden');
    const l = document.querySelector('#loginOverlay'); if (l) l.classList.remove('hidden');
  });
  await pg.waitForSelector('#loginForm [name=username]', { state: 'visible', timeout: 20000 });
  await unelte();
  await scrie('#loginForm [name="username"]', user, 55);
  await scrie('#loginForm [name="password"]', PW, 25);
  await pg.press('#loginForm [name=password]', 'Enter');
  // `{ state: 'hidden' }` EXPLICIT — capcana 4 din antet, pe alt element si cu alt simptom.
  // `waitForSelector('#loginOverlay.hidden')` cere implicit starea „visible", iar un element
  // `.hidden` nu e vizibil NICIODATA: asteptarea mergea pana la timeout, `.catch()` o inghitea,
  // si scena raporta reusita. Costul nu se vedea in jurnal, ci in film — 20 de secunde de ecran
  // de autentificare, fara voce peste ele, de trei ori (10% din durata totala).
  await pg.waitForSelector('#loginOverlay', { state: 'hidden', timeout: 20000 });
  await asteapta(2200);
  await inchideModale(); await unelte();
}
/** Luna de lucru e GLOBALA si exemplul are datele pe iunie 2026 — fara asta, ecranele ies goale.
 *
 *  Forma veche chema `window.setWorkMonth(...)`. Aia NU EXISTA: `setWorkMonth` e export de modul din
 *  `public/periods.js`, iar singurul lucru pus pe `window` de aplicatie e `goTab`. Deci apelul era
 *  `undefined` si sarit de garda `if`, functia nu facea nimic, iar filmarea raporta tot „reusit".
 *  Se vedea abia pe contactul de imagini, si numai daca te uitai la CIFRE: liste goale pe luna
 *  curenta, cu vocea vorbind despre datele lunii iunie („0 documente" in scena e-Transport).
 *
 *  Azi se scrie CHEIA pe care o citeste chiar aplicatia (`contab_workmonth`, vezi `workMonth()`),
 *  apoi se reincarca pagina — si se VERIFICA rezultatul. O luna gresita opreste filmarea in
 *  secunda 30, nu dupa 16 minute de inregistrat degeaba. */
const LUNA_EXEMPLU = '2026-06';
async function lunaExemplu() {
  await pg.evaluate((m) => { try { localStorage.setItem('contab_workmonth', m); } catch (e) { /* privat */ } }, LUNA_EXEMPLU);
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#loginOverlay', { state: 'hidden', timeout: 20000 }).catch(() => {});
  await asteapta(2200);
  await inchideModale(); await unelte();
  const luna = await pg.evaluate(() => (document.querySelector('#currentPeriod') || {}).textContent || '');
  if (!/iunie/i.test(luna)) throw new Error('luna de lucru nu s-a aplicat (e „' + luna.trim() + '", nu iunie 2026)');
}
/** Trece contul pe modul EXPERT, pe camera.
 *  Necesar, nu cosmetic: patronul porneste in modul SIMPLU, care ascunde din meniu trei grupuri
 *  intregi — Mijloace fixe, Registre contabile, Inchideri. Primele filmari au picat exact pe cele
 *  patru scene care le cer („Element is not visible"), fiindca eticheta grupului nici nu exista pe
 *  ecran. Comutarea se face ACOLO unde incepe partea tehnica a filmului, nu la inceput: scenele de
 *  dinainte arata anume vederea simpla (rezumatul „Situatia firmei" e `simple-only`). */
async function treciLaExpert() {
  const esteSimplu = await pg.evaluate(() => document.body.classList.contains('simple-ui'));
  if (esteSimplu) { await clic('#uiModeBtn', { dupa: 1400 }); await curata(); }
}

/** Deschide un document in vizualizatorul din aplicatie si il tine pe ecran. */
async function previzualizeaza(href, ms = 3200) {
  await pg.evaluate((h) => {
    const a = document.createElement('a'); a.href = h; a.textContent = 'deschide';
    a.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(a); a.click(); a.remove();
  }, href);
  await asteapta(ms);
}
const inchideViewer = () => pg.evaluate(() => { const m = document.querySelector('#pdfModal'); if (m) m.classList.add('hidden'); });

// ═══ S01 · pagina publica de prezentare ═══════════════════════════════════
await pg.goto(BASE + '/prezentare.html', { waitUntil: 'domcontentloaded' });
await asteapta(1200); await unelte();

// ═══ S01 · pagina publica de prezentare ════════════════════════════════════
await scena('s01-prezentare', async () => {
  await card('Contabo', 'Contabilitatea firmei tale,\nde la poză la declarație',
    'patronul aduce documentele · contabilul verifică și semnează', 3000);
  await derulare(0, 800);
  await derulare(700, 1800);
  await derulare(1500, 1800);
  await derulare(2400, 1800);
});

// ═══ S02 · preturile ═══════════════════════════════════════════════════════
await scena('s02-preturi', async () => {
  await pg.evaluate(() => document.querySelector('#preturi').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await asteapta(2600);
  await derulare(await pg.evaluate(() => document.querySelector('#preturi').offsetTop + 260), 2400);
  await derulare(await pg.evaluate(() => document.querySelector('#onest').offsetTop - 60), 2400);
});

// ═══ S03 · contul: patron sau contabil ════════════════════════════════════
await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('#registerBtn', { state: 'visible' });
await asteapta(600); await unelte();

// ═══ S03 · crearea contului ════════════════════════════════════════════════
await scena('s03-cont', async () => {
  await clic('#registerBtn', { dupa: 1600 });
  await pg.waitForSelector('#registerOverlay', { state: 'visible' }).catch(() => {});
  // cele doua roluri, aratate pe rand: de aici incolo filmul le urmareste separat
  await clic('.reg-tip-op:has-text("contabil")', { dupa: 1500 }).catch(() => {});
  await clic('.reg-tip-op:has-text("patron")', { dupa: 1500 }).catch(() => {});
});

// ═══ S04 · cele doua roluri ════════════════════════════════════════════════
await scena('s04-doua-roluri', async () => {
  await card('Doi oameni, două roluri', 'Patronul aduce.\nContabilul răspunde.',
    'aplicația face munca dintre ei — nu ține locul niciunuia', 7000);
  await pg.evaluate(() => { const e = document.querySelector('#registerOverlay'); if (e) e.classList.add('hidden'); });
});

// ═══ S05 · lista contabililor inscrisi ════════════════════════════════════
await intraCa('patron');

// ═══ S05 · lista de contabili ══════════════════════════════════════════════
await scena('s05-lista-contabili', async () => {
  await meniu('Setări', 'acces', 1500);
  await pg.evaluate(() => document.querySelector('#contabiliCard').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await asteapta(2600);
  await pg.evaluate(() => { const t = document.querySelector('#contabiliList table'); if (t) t.classList.add('__tinta'); });
  await asteapta(3200);
  await pg.evaluate(() => { const t = document.querySelector('#contabiliList table'); if (t) t.classList.remove('__tinta'); });
});

// ═══ S06 · angajarea contabilului ══════════════════════════════════════════
await scena('s06-angajare', async () => {
  // selectorul de firma din randul contabilei — patronul alege PENTRU CARE firma il vrea
  const sel = pg.locator('#contabiliList select').first();
  if (await sel.count()) {
    await cursorLa(sel);
    await sel.selectOption({ index: 1 }).catch(() => {});
    await asteapta(1600);
  }
  await pg.evaluate(() => document.querySelector('#serviciiTrimise').scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await asteapta(2400);
  await pg.evaluate(() => { const t = document.querySelector('#serviciiTrimise table'); if (t) t.classList.add('__tinta'); });
  await asteapta(3000);
  await pg.evaluate(() => { const t = document.querySelector('#serviciiTrimise table'); if (t) t.classList.remove('__tinta'); });
});

// ═══ S07 · contabilul accepta — pe contul LUI ═════════════════════════════
await intraCa('maria');

// ═══ S07 · acceptarea cererii ══════════════════════════════════════════════
await scena('s07-acceptare', async () => {
  await meniu('Setări', 'acces', 1500);
  await pg.evaluate(() => document.querySelector('#serviciiPrimite').scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await asteapta(1800);
  await clicDaca('#serviciiPrimite button:has-text("Accept")', { dupa: 2600 });
  await curata();
  await asteapta(1500);
});

// ═══ S08 · multi-firma ═════════════════════════════════════════════════════
await scena('s08-multi-firma', async () => {
  // selectorul de firme al contabilei: firme de la DOI patroni diferiti
  await derulare(0, 800);
  const sel = pg.locator('#firmaSelect');
  await cursorLa(sel);
  await pg.evaluate(() => { const s = document.querySelector('#firmaSelect'); s.classList.add('__tinta'); s.size = 4; });
  await asteapta(4200);
  await pg.evaluate(() => { const s = document.querySelector('#firmaSelect'); s.classList.remove('__tinta'); s.size = 0; });
  await asteapta(600);
});

// ═══ S09 · portofoliul contabilului ════════════════════════════════════════
await scena('s09-portofoliu', async () => {
  // Miscarea acopera TOATA replica: `scena()` asteapta restul cu ecranul inghetat, iar filmul
  // isi semnaleaza singur pauzele peste 6 s. Voce 14,2 s -> aici ~14 s de miscare.
  await intra('portofoliu', 2600);
  await derulare(200, 2400);
  await derulare(420, 2400);
  await derulare(160, 2400);
  await derulare(0, 2200);
});

// ═══ S10 · prima intrare, meniul pe ciclul contabil ═══════════════════════
await intraCa('patron');
await lunaExemplu();

// ═══ FAZA 1 · deschiderea exercitiului ═════════════════════════════════════
await scena('s10-primaintrare', async () => {
  await intra('dashboard', 1200);
  await clic('#tabs .navlabel:has-text("Documente")', { dupa: 1100 });
  await clic('#tabs .navlabel:has-text("Bani")', { dupa: 1000 });
  await clic('#tabs .navlabel:has-text("Taxe")', { dupa: 1000 });
  await clic('#tabs .navlabel:has-text("Rapoarte")', { dupa: 1400 });
});

// ═══ S11 · ghidul din aplicatie ════════════════════════════════════════════
await scena('s11-ghid', async () => {
  await intra('ghid', 1800);
  await derulare(500, 2200);
  await derulare(1200, 2000);
  await derulare(0, 900);
  await clicDaca('#glossaryBtn', { dupa: 2400 });
  await pg.evaluate(() => { const m = document.querySelector('#glossaryModal'); if (m) m.classList.add('hidden'); });
});

// ═══ S12 · tabloul de bord ═════════════════════════════════════════════════
await scena('s12-acasa', async () => {
  await intra('dashboard', 1600);
  await curata();
  await derulare(0, 900);
  await derulare(320, 2400);
  await derulare(700, 2200);
});
// ═══ S12b · interfața modernă — AICI se trece pe expert ════════════════════
// Se arată ierarhia unică: arbore lateral, context firmă/perioadă și ajutor la cerere.
await scena('s12b-birou', async () => {
  await treciLaExpert();
  await derulare(0, 700);
  const context = pg.locator('#appContext');
  if (await context.count()) { await cursorLa(context); await asteapta(1200); }
  const arb = pg.locator('#tabs .navlabel').nth(1);
  if (await arb.count()) { await cursorLa(arb); await arb.click(); await asteapta(1100); }
  await clicDaca('#tab-dashboard .context-help > summary', { dupa: 1700 });
  await clicDaca('#tab-dashboard .context-help > summary', { dupa: 700 });
});

// ═══ S12c · modul simplu ═══════════════════════════════════════════════════
await scena('s12c-simplu', async () => {
  await intra('dashboard', 1200);
  await clic('#uiModeBtn', { dupa: 2600 });   // expert -> simplu
  await derulare(260, 1800);
  await derulare(0, 1200);
  await clic('#uiModeBtn', { dupa: 2200 });   // si inapoi: nimic nu s-a pierdut
  await curata();
});

// ═══ S10b · planul de conturi ══════════════════════════════════════════════
await scena('s10b-plan', async () => {
  await meniu('Date firmă', 'plan', 2000);
  await derulare(0, 700);
  await derulare(320, 2200);
});

// ═══ S10c · preluarea soldurilor ═══════════════════════════════════════════
await scena('s10c-solduri', async () => {
  await meniu('Setări', 'date', 1800);
  await pg.evaluate(() => { const e = document.querySelector('#openingCard'); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  await asteapta(3400);
});

// ═══ S10d · migrarea de la alt program ═════════════════════════════════════
await scena('s10d-migrare', async () => {
  await pg.evaluate(() => { const e = document.querySelector('#migrationCompleteCard'); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  await asteapta(2600);
  await card('Aduci evidenta de la alt program', 'balanta, parteneri,\nstocuri, mijloace fixe',
    'XLS · CSV · DBF — previzualizare inainte de scriere\npotrivirea coloanelor se salveaza si se refoloseste', 6500);
});

// ═══ FAZA 2 · documentele justificative ════════════════════════════════════
await scena('s13-document', async () => {
  await meniu('Documente', 'documente', 1800);
  await derulare(0, 800);
  await clicDaca('#manualBtn', { dupa: 2200 });
  await derulare(320, 2000);
});

// ═══ S14 · documentul atasat ═══════════════════════════════════════════════
await scena('s14-preview-pdf', async () => {
  await inchideModale();
  await intra('intrate', 1600);
  await previzualizeaza('/pdf/factura/e2', 6000);
  await inchideViewer();
  await asteapta(600);
});

// ═══ S15 · previzualizarea notei contabile ═════════════════════════════════
await scena('s15-previzualizare', async () => {
  await meniu('Documente', 'documente', 1400);
  await clicDaca('#manualBtn', { dupa: 1200 });
  await pg.evaluate(() => { const s = document.querySelector('#tipSelect'); if (s) { s.value = 'factura_cumparare_marfuri'; s.dispatchEvent(new Event('change', { bubbles: true })); } });
  await asteapta(1500);
  await scrie('#fld_partener', 'ALFA DISTRIBUTIE SRL', 30);
  await scrie('#fld_document', 'AFD 1302', 40);
  await scrie('#fld_baza', '9200', 45);
  await asteapta(2600);
  await pg.evaluate(() => { const p = document.querySelector('#preview'); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  await asteapta(2600);
});

// ═══ S16 · controalele de calitate ═════════════════════════════════════════
await scena('s16-controale', async () => {
  await card('Înainte să intre în contabilitate', 'Opt controale, toate blocante',
    'aritmetica · cota de TVA · data și luna închisă · numărul documentului\npartener cunoscut · duplicat · încredere · tip determinat', 8000);
  await clicDaca('#cancelEntry', { dupa: 800 });
  await intra('intrate', 1600);
  await derulare(400, 2200);
});

// ═══ S16b · fluxul ciorna -> postat ════════════════════════════════════════
await scena('s16b-flux', async () => {
  await meniu('Documente', 'intrate', 2000);
  await derulare(0, 700);
  await derulare(300, 2400);
});

// ═══ S17 · emiterea facturii ═══════════════════════════════════════════════
await scena('s17-emite', async () => {
  await meniu('Documente', 'emite', 1800);
  await derulare(0, 900);
  await clicDaca('.emit[data-tip="factura_vanzare_marfuri"]', { dupa: 2400 });
  await derulare(260, 2000);
  await clicDaca('#cancelEntry', { dupa: 600 });
});

// ═══ S18 · e-Factura ═══════════════════════════════════════════════════════
await scena('s18-preview-efactura', async () => {
  await intra('iesite', 1800);
  await previzualizeaza('/xml/efactura/e2', 5600);
  await inchideViewer();
  await asteapta(500);
});

// ═══ FAZA 3 · trezoreria ═══════════════════════════════════════════════════
await scena('s19-bani', async () => {
  await meniu('Bani', 'cashbook', 1800);
  await derulare(0, 800);
  await derulare(260, 2200);
  await derulare(560, 2000);
});

// ═══ S19b · reconcilierea bancara ══════════════════════════════════════════
await scena('s19b-reconciliere', async () => {
  await meniu('Bani', 'reconciliere', 2000);
  await derulare(0, 800);
  await derulare(300, 2400);
  await derulare(680, 2200);
});

// ═══ FAZA 4 · stocurile ════════════════════════════════════════════════════
await scena('s20-stocuri', async () => {
  await meniu('Stocuri', 'stocuri', 1800);
  await derulare(300, 2200);
  await derulare(700, 2000);
});

// ═══ S20b · productia ══════════════════════════════════════════════════════
await scena('s20b-productie', async () => {
  await meniu('Stocuri', 'productie', 2000);
  await derulare(0, 800);
  await derulare(320, 2400);
});

// ═══ S20c · inventarierea ══════════════════════════════════════════════════
await scena('s20c-inventariere', async () => {
  await intra('stocuri', 1600);
  // Inventarierea sta jos in pagina de stocuri (lista de inventar + plusuri/minusuri).
  await pg.evaluate(() => { const e = document.querySelector('#invPdf'); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  await asteapta(3600);
});

// ═══ FAZA 5 · salariile ════════════════════════════════════════════════════
await scena('s21-salarii', async () => {
  await meniu('Salarii', 'salarizare', 2000);
  await derulare(300, 2400);
  await derulare(750, 2200);
});

// ═══ S21b · dosarul angajatului ════════════════════════════════════════════
await scena('s21b-angajati', async () => {
  await meniu('Salarii', 'angajati', 2000);
  await derulare(0, 800);
  await derulare(300, 2400);
});

// ═══ S21c · registrul anual de salarii ═════════════════════════════════════
await scena('s21c-regsalarii', async () => {
  await meniu('Salarii', 'regsalarii', 2200);
  await derulare(240, 2400);
});

// ═══ FAZA 6 · imobilizarile ════════════════════════════════════════════════
await scena('s22-mijloace', async () => {
  await treciLaExpert();
  await meniu('Mijloace fixe', 'mijloace', 1800);
  await derulare(300, 2000);
  await derulare(700, 2000);
});

// ═══ S22c · leasingul ══════════════════════════════════════════════════════
await scena('s22c-leasing', async () => {
  await meniu('Mijloace fixe', 'leasing', 2200);
  await derulare(260, 2400);
});

// ═══ FAZA 7 · regularizarile ═══════════════════════════════════════════════
await scena('s24a-regularizari', async () => {
  await card('Faza 7', 'Regularizările de sfârșit de perioadă',
    'nu vin dintr-un document primit · fără ele bilanțul nu e adevărat', 3200);
  await meniu('Închideri', 'inchideri', 2000);
});

// ═══ S24b · reevaluarea valutara ═══════════════════════════════════════════
await scena('s24b-reevaluare', async () => {
  await pg.evaluate(() => { const e = document.querySelector('#fxRevalArea'); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  await asteapta(3800);
});

// ═══ S24c · ajustarile pentru creante ══════════════════════════════════════
await scena('s24c-ajustari', async () => {
  await meniu('Rapoarte', 'analitic', 2000);
  await pg.evaluate(() => { const e = document.querySelector('#provPct'); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  await asteapta(3600);
});

// ═══ S24d · stornarile ═════════════════════════════════════════════════════
await scena('s24d-storno', async () => {
  await meniu('Registre', 'storno', 2200);
  await derulare(220, 2400);
});

// ═══ S24e · delimitarea in timp ════════════════════════════════════════════
await scena('s24e-avans', async () => {
  await card('Regularizări', 'Cheltuieli și venituri în avans',
    'înregistrare · recunoaștere lună de lună · pro-rata anuală · ajustări de TVA', 3400);
  await meniu('Documente', 'documente', 2200);
});

// ═══ FAZA 8 · registrele obligatorii ═══════════════════════════════════════
await scena('s23-registre', async () => {
  await meniu('Registre', 'jurnal', 1800);
  await derulare(260, 1800);
  await derulare(620, 2000);
});

// ═══ S23b · cartea mare ════════════════════════════════════════════════════
await scena('s23b-carte', async () => {
  await meniu('Registre', 'carte', 2000);
  await derulare(0, 700);
  await derulare(300, 2400);
});

// ═══ S23c · balanta de verificare ══════════════════════════════════════════
await scena('s23c-balanta', async () => {
  await meniu('Registre', 'balanta', 2200);
  await derulare(0, 700);
  await derulare(320, 2400);
});

// ═══ S22d · scadentarul ════════════════════════════════════════════════════
await scena('s22d-scadentar', async () => {
  await meniu('Rapoarte', 'analitic', 2000);
  await derulare(0, 700);
  await derulare(300, 2400);
});

// ═══ FAZA 9 · TVA ══════════════════════════════════════════════════════════
await scena('s28-tva', async () => {
  await meniu('Taxe', 'tva', 2200);
  await derulare(0, 800);
  await derulare(300, 2400);
  await derulare(800, 2000);
});

// ═══ S29 · decontul precompletat ═══════════════════════════════════════════
await scena('s29-etva', async () => {
  await pg.evaluate(() => { const e = document.querySelector('#etvaPrecompletatCard'); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  await asteapta(3200);
});
// ═══ S29b · e-Transport (cod UIT) ═════════════════════════════════════════
// Formularul NU e un tab: butonul „e-Transport" apare pe articolele eligibile din lista de
// documente emise (`button.ettrans`). Se deschide de acolo, si se inchide explicit dupa —
// un modal ramas pe ecran ar inghiti clicurile scenei urmatoare (capcana 2 din antet).

// ═══ S29b · e-Transport ════════════════════════════════════════════════════
await scena('s29b-etransport', async () => {
  await meniu('Documente', 'iesite', 2000);
  await derulare(0, 700);
  // Selectorul e LEGAT DE TAB, si asta e miezul. `button.ettrans` exista de DOUA ori in pagina:
  // o data in `#tab-documente` (ascuns, latime 0) si o data in `#tab-iesite` (cel de pe ecran).
  // Playwright leaga `waitForSelector`/`.first()` de PRIMA potrivire din DOM — adica de cea din
  // tabul ascuns, care nu devine vizibila niciodata. Cu `clicDaca` asta trecea tacut (scena filma
  // o lista statica peste vocea despre codul UIT); cu asteptare, pica dupa 12 s. Ambele simptome,
  // aceeasi cauza. Regula pentru orice scena noua: tinteste in interiorul tabului, nu global.
  // Lista se randeaza si DUPA un apel de retea, deci asteptarea ramane necesara.
  await pg.waitForSelector('#tab-iesite button.ettrans', { state: 'visible', timeout: 12000 });
  await clic('#tab-iesite button.ettrans', { dupa: 2400 });
  await pg.waitForSelector('#etModal:not(.hidden)', { timeout: 10000 });
  await asteapta(3200);
  await pg.evaluate(() => { const m = document.querySelector('#etModal'); if (m) m.classList.add('hidden'); });
});

// ═══ S29c · Intrastat ══════════════════════════════════════════════════════
await scena('s29c-intrastat', async () => {
  await meniu('Taxe', 'livrabile', 2000);
  await derulare(520, 2200);
  await card('Intrastat', 'statistica, nu fiscalitate',
    'se depune la Institutul National de Statistica\nprag anual, socotit separat pe fiecare sens', 6000);
});

// ═══ FAZA 10 · inchiderea lunii ════════════════════════════════════════════
await scena('s25-inchidere', async () => {
  await meniu('Închideri', 'inchideri', 2200);
  await derulare(260, 2400);
  await derulare(700, 2400);
});

// ═══ S25b · blocarea perioadei ═════════════════════════════════════════════
await scena('s25b-blocare', async () => {
  await derulare(1100, 2600);
  await card('Perioadă blocată', 'Forțarea cere administrator și motiv scris',
    'motivul rămâne în jurnalul de audit', 2600);
});

// ═══ FAZA 11 · inchiderea anului ═══════════════════════════════════════════
await scena('s26-inchidere-an', async () => {
  await meniu('Închideri', 'inchidere-an', 2000);
  await derulare(300, 2400);
});

// ═══ S27 · registrul de evidenta fiscala ═══════════════════════════════════
await scena('s27-regfiscal', async () => {
  await meniu('Taxe', 'regfiscal', 2000);
  await derulare(300, 2400);
});

// ═══ S26b · repartizarea rezultatului ══════════════════════════════════════
await scena('s26b-repartizare', async () => {
  await derulare(700, 2600);
  await derulare(1100, 2400);
});

// ═══ FAZA 12 · situatiile financiare ═══════════════════════════════════════
await scena('s26c-situatii', async () => {
  await meniu('Rapoarte', 'situatii', 2400);
  await derulare(0, 700);
  await derulare(340, 2400);
  await derulare(820, 2200);
});

// ═══ S26d · anexele la situatii ════════════════════════════════════════════
await scena('s26d-anexe', async () => {
  await meniu('Rapoarte', 'anexe', 2400);
  await derulare(0, 700);
  await derulare(340, 2400);
  await derulare(820, 2200);
});

// ═══ FAZA 13 · declaratiile ════════════════════════════════════════════════
await scena('s30-declaratii', async () => {
  await meniu('Taxe', 'livrabile', 2400);
  await derulare(0, 800);
  await derulare(300, 2600);
  await derulare(700, 2200);
});

// ═══ S30c · declaratiile de situatie ═══════════════════════════════════════
await scena('s30c-situatie', async () => {
  await derulare(900, 2000);
  await card('Declaratii care apar din SITUATIE', 'D301 · D307 · D311 · D107',
    'nu se depun niciodata — pana in luna in care se depun\naplicatia le propune din operatiunile inregistrate', 7000);
});

// ═══ S30d · corectia unei declaratii depuse ════════════════════════════════
await scena('s30d-corectie', async () => {
  await derulare(1200, 1800);
  await card('Cand declaratia e gresita', 'rectificativa vs. D710',
    'decontul, informativa, salariile -> se INLOCUIESC integral\nobligatiile de plata -> se corecteaza pe o singura suma', 7000);
  await derulare(0, 900);
});

// ═══ S30b · depunerea prin SPV ═════════════════════════════════════════════
await scena('s30b-spv', async () => {
  await meniu('Taxe', 'spv', 2200);
  await derulare(0, 800);
  await derulare(320, 2400);
});

// ═══ S31 · fisierul XML ════════════════════════════════════════════════════
await scena('s31-preview-xml', async () => {
  await previzualizeaza('/xml/d300?period=2026-06', 5600);
  await inchideViewer();
  await asteapta(500);
});

// ═══ S32 · SAF-T ═══════════════════════════════════════════════════════════
await scena('s32-saft', async () => {
  await meniu('Taxe', 'saft', 2200);
  await derulare(300, 2400);
});

// ═══ S31b · validarea oficiala ═════════════════════════════════════════════
await scena('s31b-validare', async () => {
  await card('Dovada', 'Fiecare declarație trece validatoarele OFICIALE ANAF',
    'la fiecare modificare a codului · „n-am putut verifica" = „e greșit"', 4200);
});

// ═══ FAZA 14 · arhivarea ═══════════════════════════════════════════════════
await scena('s34-arhiva', async () => {
  await meniu('Date firmă', 'arhiva', 2200);
  await derulare(260, 2400);
});

// ═══ S33 · rapoartele de conducere ═════════════════════════════════════════
await scena('s33-rapoarte', async () => {
  await meniu('Rapoarte', 'situatii', 2200);
  await derulare(300, 2400);
  await meniu('Rapoarte', 'analitic', 2200);
});

// ═══ S33b · bugetul ════════════════════════════════════════════════════════
await scena('s33b-buget', async () => {
  await meniu('Rapoarte', 'buget', 2200);
  await derulare(280, 2400);
  await meniu('Rapoarte', 'analitic', 2200);
  await derulare(260, 2400);
});

// ═══ S24 · exportul in tabel ═══════════════════════════════════════════════
await scena('s24-preview-csv', async () => {
  await previzualizeaza('/csv/balance?period=2026-06', 5600);
  await inchideViewer();
  await asteapta(500);
});

// ═══ S22b · clientii si furnizorii ═════════════════════════════════════════
await scena('s22b-parteneri', async () => {
  await meniu('Date firmă', 'parteneri', 2000);
  await derulare(0, 800);
  await derulare(280, 2400);
});

// ═══ S35 · setarile firmei ═════════════════════════════════════════════════
await scena('s35-setari', async () => {
  await meniu('Setări', 'setari', 1600);
  await intra('cont', 1600);
  await intra('acces', 1600);
  await intra('date', 1600);
  await intra('conexiuni', 2000);
});

// ═══ S36 · jurnalul de audit ═══════════════════════════════════════════════
await scena('s36-audit', async () => {
  await intra('audit', 2000);
  await derulare(260, 2400);
  await derulare(0, 1000);
});

// ═══ S36b · cautarea globala ═══════════════════════════════════════════════
await scena('s36b-cautare', async () => {
  await clic('#paletaBtn', { dupa: 1100 });
  await scrie('#paletaSearch', 'balanta', 65);
  await asteapta(1800);
  await clicDaca('#paletaClose', { dupa: 900 });
  await clic('#glossaryBtn', { dupa: 1600 });
  await derulare(0, 600);
  await pg.evaluate(() => { const m = document.querySelector('#glossaryModal'); if (m) m.classList.add('hidden'); });
  await asteapta(600);
  await clic('#uiModeBtn', { dupa: 1800 });   // expert -> simplu, ca sa se vada meniul strangandu-se
  await curata();
});

// ═══ S36c · cartea ═════════════════════════════════════════════════════════
await scena('s36c-carte', async () => {
  // „Cartea" din meniu e o LEGATURA externa (`<a href="/carte/">`), nu un tab: `intra()` n-are ce
  // deschide, iar `target="_blank"` ar duce inregistrarea intr-o pagina noua, nefilmata. Se merge
  // direct la pagina cartii, in ACEEASI fila, si se revine dupa.
  await pg.goto(BASE + '/carte/', { waitUntil: 'domcontentloaded' });
  await asteapta(1600);
  await derulare(600, 2200);
  await derulare(1800, 2000);
  await card('O carte, nu un manual de utilizare', 'contabilitatea in ordinea\nin care se intampla',
    'acelasi drum ca in aplicatie: documentul, banii,\nregistrele, declaratiile, inchiderea', 6500);
  // Revenirea in aplicatie: se ASTEAPTA bara de taburi, nu un numar de milisecunde. Sesiunea
  // exista (cookie-ul e neatins), dar `init()` are nevoie de timpul lui — iar scena urmatoare
  // incepe cu `intra('date')`, care ar cadea pe un DOM inca gol.
  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#tabs button[data-tab="date"]', { state: 'attached', timeout: 20000 });
  await asteapta(1200); await unelte();
});

// ═══ S37 · increderea (backup) ═════════════════════════════════════════════
await scena('s37-incredere', async () => {
  await intra('date', 1600);
  await curata(); await derulare(300, 2200);
  await derulare(620, 2200);
  await card('De ce poți avea încredere', 'Validat cu validatorul\npublicat de ANAF',
    'peste 5.200 de verificări automate la fiecare versiune\nbackup zilnic, cu copie în afara serverului', 8000);
  await derulare(300, 2000);
  await derulare(0, 1800);
});

// ═══ S37b · recuperarea, probata ═══════════════════════════════════════════
await scena('s37b-recuperare', async () => {
  // Scena precedenta lasa ecranul TOT pe „date": `intra()` e atunci instant, iar o derulare la
  // aceeasi pozitie nu misca nimic — asa au iesit 11,6 s de ecran inghetat. Se porneste de sus.
  await curata(); await derulare(0, 1200);
  await derulare(520, 2200);
  await derulare(900, 2200);
  await card('Copia de siguranta se PROBEAZA', 'criptata, in afara serverului',
    'refacerea se incearca automat, pe o masina goala,\ncu unelte obisnuite — nu depinde de acest program', 7000);
  await derulare(300, 1800);
});

// ═══ S38 · limitele ════════════════════════════════════════════════════════
await scena('s38-limite', async () => {
  await card('Ce rămâne la voi', 'Cinstit, până la capăt',
    'depunerea în SPV, cu certificatul digital al firmei\nvalidarea finală, cu DUKIntegrator\ncasa de marcat rămâne obligatorie separat\nbilanțul cere semnătura contabilului autorizat', 20000);
});

// ═══ S39 · final ═══════════════════════════════════════════════════════════
await scena('s39-final', async () => {
  await card('30 de zile gratuit, fără card', 'contabo.space',
    'patronul aduce documentele · contabilul verifică și semnează', 9000);
});

const TOTAL = clipa();
fs.writeFileSync('/w/out/timeline.json', JSON.stringify({ scene: timeline, total: TOTAL }, null, 1));
console.log(jurnal.join('\n'));
console.log('durata inregistrarii: %s s', TOTAL.toFixed(1));

// ── TIMPUL MORT, raportat de filmare ────────────────────────────────────────
// Ce nu se vede in jurnal: o scena poate „reusi" si totusi sa lase ecranul inghetat, daca intre
// ea si urmatoarea se face munca fara voce peste ea (autentificare, schimbare de actor) sau daca
// o asteptare merge pana la timeout. Asa au ajuns 76 de secunde moarte, 10% din film, si s-au
// vazut abia la vizionare — cu trei intervale de cate 25 de secunde de ecran de login.
// De aceea filmarea isi masoara singura golurile: jurnalul spune ce a reusit, asta spune ce se VEDE.
const PRAG = 6;
const goluri = timeline.map((s, i) => {
  const urm = i + 1 < timeline.length ? timeline[i + 1].start : TOTAL;
  return { id: s.id, gol: Number((urm - s.start - (DUR[s.id] || 0) - 1.5).toFixed(1)) };
}).filter((x) => x.gol > PRAG);
if (goluri.length) {
  console.log('\n⚠ ECRAN STATIC, fara voce peste el (peste %s s):', PRAG);
  goluri.forEach((x) => console.log('   %s — %s s', x.id.padEnd(24), x.gol));
  console.log('   TOTAL timp mort: %s s din %s s', goluri.reduce((t, x) => t + x.gol, 0).toFixed(0), TOTAL.toFixed(0));
} else {
  console.log('\n✓ niciun ecran static peste %s s', PRAG);
}
await ctx.close();
await b.close();
