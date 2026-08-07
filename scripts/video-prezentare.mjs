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
/** Luna de lucru e GLOBALA si exemplul are datele pe iunie 2026 — fara asta, ecranele ies goale. */
async function lunaExemplu() {
  await pg.evaluate(() => { if (window.setWorkMonth) { window.setWorkMonth('2026-06'); if (window.applyWorkMonth) window.applyWorkMonth(); } });
  await asteapta(1200);
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
await scena('s01-prezentare', async () => {
  await card('Contabo', 'Contabilitatea firmei tale,\nde la poză la declarație',
    'patronul aduce documentele · contabilul verifică și semnează', 3000);
  await derulare(0, 800);
  await derulare(700, 1800);
  await derulare(1500, 1800);
  await derulare(2400, 1800);
});

// ═══ S02 · preturile ══════════════════════════════════════════════════════
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
await scena('s03-cont', async () => {
  await clic('#registerBtn', { dupa: 1600 });
  await pg.waitForSelector('#registerOverlay', { state: 'visible' }).catch(() => {});
  // cele doua roluri, aratate pe rand: de aici incolo filmul le urmareste separat
  await clic('.reg-tip-op:has-text("contabil")', { dupa: 1500 }).catch(() => {});
  await clic('.reg-tip-op:has-text("patron")', { dupa: 1500 }).catch(() => {});
});

// ═══ S04 · doua roluri, doua raspunderi ═══════════════════════════════════
await scena('s04-doua-roluri', async () => {
  await card('Doi oameni, două roluri', 'Patronul aduce.\nContabilul răspunde.',
    'aplicația face munca dintre ei — nu ține locul niciunuia', 7000);
  await pg.evaluate(() => { const e = document.querySelector('#registerOverlay'); if (e) e.classList.add('hidden'); });
});

// ═══ S05 · lista contabililor inscrisi ════════════════════════════════════
await intraCa('patron');
await scena('s05-lista-contabili', async () => {
  await meniu('Setări', 'acces', 1500);
  await pg.evaluate(() => document.querySelector('#contabiliCard').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await asteapta(2600);
  await pg.evaluate(() => { const t = document.querySelector('#contabiliList table'); if (t) t.classList.add('__tinta'); });
  await asteapta(3200);
  await pg.evaluate(() => { const t = document.querySelector('#contabiliList table'); if (t) t.classList.remove('__tinta'); });
});

// ═══ S06 · angajarea: cererea pentru o firma anume ════════════════════════
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
await scena('s07-acceptare', async () => {
  await meniu('Setări', 'acces', 1500);
  await pg.evaluate(() => document.querySelector('#serviciiPrimite').scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await asteapta(1800);
  await clicDaca('#serviciiPrimite button:has-text("Accept")', { dupa: 2600 });
  await curata();
  await asteapta(1500);
});

// ═══ S08 · mai multi patroni, mai multe firme ═════════════════════════════
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

// ═══ S09 · portofoliul contabilului ═══════════════════════════════════════
await scena('s09-portofoliu', async () => {
  await intra('portofoliu', 2600);
  await derulare(200, 2200);
  await derulare(0, 1200);
});

// ═══ S10 · prima intrare, meniul pe ciclul contabil ═══════════════════════
await intraCa('patron');
await lunaExemplu();
await scena('s10-primaintrare', async () => {
  await intra('dashboard', 1200);
  await clic('#tabs .navlabel:has-text("Documente")', { dupa: 1100 });
  await clic('#tabs .navlabel:has-text("Bani")', { dupa: 1000 });
  await clic('#tabs .navlabel:has-text("Taxe")', { dupa: 1000 });
  await clic('#tabs .navlabel:has-text("Rapoarte")', { dupa: 1400 });
});

// ═══ S11 · ghidul si dictionarul ══════════════════════════════════════════
await scena('s11-ghid', async () => {
  await intra('ghid', 1800);
  await derulare(500, 2200);
  await derulare(1200, 2000);
  await derulare(0, 900);
  await clicDaca('#glossaryBtn', { dupa: 2400 });
  await pg.evaluate(() => { const m = document.querySelector('#glossaryModal'); if (m) m.classList.add('hidden'); });
});

// ═══ S12 · Acasa: „De facut acum" + situatia firmei ═══════════════════════
await scena('s12-acasa', async () => {
  await intra('dashboard', 1600);
  await curata();
  await derulare(0, 900);
  await derulare(320, 2400);
  await derulare(700, 2200);
});

// ═══ S13 · documentele primite ════════════════════════════════════════════
await scena('s13-document', async () => {
  await meniu('Documente', 'documente', 1800);
  await derulare(0, 800);
  await clicDaca('#manualBtn', { dupa: 2200 });
  await derulare(320, 2000);
});

// ═══ S14 · PREVIZUALIZARE: documentul PDF, in aplicatie ═══════════════════
await scena('s14-preview-pdf', async () => {
  await inchideModale();
  await intra('intrate', 1600);
  await previzualizeaza('/pdf/factura/e2', 6000);
  await inchideViewer();
  await asteapta(600);
});

// ═══ S15 · previzualizarea notei contabile ════════════════════════════════
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

// ═══ S16 · controalele de calitate ════════════════════════════════════════
await scena('s16-controale', async () => {
  await card('Înainte să intre în contabilitate', 'Opt controale, toate blocante',
    'aritmetica · cota de TVA · data și luna închisă · numărul documentului\npartener cunoscut · duplicat · încredere · tip determinat', 8000);
  await clicDaca('#cancelEntry', { dupa: 800 });
  await intra('intrate', 1600);
  await derulare(400, 2200);
});

// ═══ S17 · emiterea facturii ══════════════════════════════════════════════
await scena('s17-emite', async () => {
  await meniu('Documente', 'emite', 1800);
  await derulare(0, 900);
  await clicDaca('.emit[data-tip="factura_vanzare_marfuri"]', { dupa: 2400 });
  await derulare(260, 2000);
  await clicDaca('#cancelEntry', { dupa: 600 });
});

// ═══ S18 · PREVIZUALIZARE: e-Factura XML, citibila ════════════════════════
await scena('s18-preview-efactura', async () => {
  await intra('iesite', 1800);
  await previzualizeaza('/xml/efactura/e2', 5600);
  await inchideViewer();
  await asteapta(500);
});

// ═══ S19 · banii: incasari, plati, extras ═════════════════════════════════
await scena('s19-bani', async () => {
  await meniu('Bani', 'cashbook', 1800);
  await derulare(0, 800);
  await derulare(260, 2200);
  await meniu('Bani', 'reconciliere', 2000);
});

// ═══ S20 · stocurile ══════════════════════════════════════════════════════
await scena('s20-stocuri', async () => {
  await meniu('Stocuri', 'stocuri', 1800);
  await derulare(300, 2200);
  await derulare(700, 2000);
});

// ═══ S21 · salariile ══════════════════════════════════════════════════════
await scena('s21-salarii', async () => {
  await meniu('Salarii', 'salarizare', 2000);
  await derulare(300, 2400);
  await derulare(750, 2200);
});

// ═══ S22 · mijloace fixe si leasing ═══════════════════════════════════════
await scena('s22-mijloace', async () => {
  await treciLaExpert();
  await meniu('Mijloace fixe', 'mijloace', 1800);
  await derulare(300, 2000);
  await meniu('Mijloace fixe', 'leasing', 2000);
});

// ═══ S23 · registrele si balanta ══════════════════════════════════════════
await scena('s23-registre', async () => {
  await meniu('Registre', 'jurnal', 1800);
  await derulare(260, 1800);
  await meniu('Registre', 'balanta', 2000);
  await derulare(200, 2000);
});

// ═══ S24 · PREVIZUALIZARE: registrul ca text simplu (CSV) ═════════════════
await scena('s24-preview-csv', async () => {
  await previzualizeaza('/csv/balance?period=2026-06', 5600);
  await inchideViewer();
  await asteapta(500);
});

// ═══ S25 · inchiderea lunii ═══════════════════════════════════════════════
await scena('s25-inchidere', async () => {
  await meniu('Închideri', 'inchideri', 2200);
  await derulare(260, 2400);
  await derulare(700, 2400);
});

// ═══ S26 · inchiderea anului ══════════════════════════════════════════════
await scena('s26-inchidere-an', async () => {
  await meniu('Închideri', 'inchidere-an', 2000);
  await derulare(300, 2400);
});

// ═══ S27 · registrul de evidenta fiscala ══════════════════════════════════
await scena('s27-regfiscal', async () => {
  await meniu('Taxe', 'regfiscal', 2000);
  await derulare(300, 2400);
});

// ═══ S28 · decontul de TVA ════════════════════════════════════════════════
await scena('s28-tva', async () => {
  await meniu('Taxe', 'tva', 2200);
  await derulare(0, 800);
  await derulare(300, 2400);
  await derulare(800, 2000);
});

// ═══ S29 · decontul precompletat e-TVA ════════════════════════════════════
await scena('s29-etva', async () => {
  await pg.evaluate(() => { const e = document.querySelector('#etvaPrecompletatCard'); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  await asteapta(3200);
});

// ═══ S30 · declaratiile lunii ═════════════════════════════════════════════
await scena('s30-declaratii', async () => {
  await meniu('Taxe', 'livrabile', 2400);
  await derulare(0, 800);
  await derulare(300, 2600);
  await derulare(700, 2200);
});

// ═══ S31 · PREVIZUALIZARE: XML-ul de declaratie, aranjat ══════════════════
await scena('s31-preview-xml', async () => {
  await previzualizeaza('/xml/d300?period=2026-06', 5600);
  await inchideViewer();
  await asteapta(500);
});

// ═══ S32 · SAF-T ══════════════════════════════════════════════════════════
await scena('s32-saft', async () => {
  await meniu('Taxe', 'saft', 2200);
  await derulare(300, 2400);
});

// ═══ S33 · rapoartele ═════════════════════════════════════════════════════
await scena('s33-rapoarte', async () => {
  await meniu('Rapoarte', 'situatii', 2200);
  await derulare(300, 2400);
  await meniu('Rapoarte', 'analitic', 2200);
});

// ═══ S34 · arhiva lunii ═══════════════════════════════════════════════════
await scena('s34-arhiva', async () => {
  await meniu('Date firmă', 'arhiva', 2200);
  await derulare(260, 2400);
});

// ═══ S35 · setarile ═══════════════════════════════════════════════════════
await scena('s35-setari', async () => {
  await meniu('Setări', 'setari', 1600);
  await intra('cont', 1600);
  await intra('acces', 1600);
  await intra('date', 1600);
  await intra('conexiuni', 2000);
});

// ═══ S36 · jurnalul de audit ══════════════════════════════════════════════
await scena('s36-audit', async () => {
  await intra('audit', 2000);
  await derulare(260, 2400);
  await derulare(0, 1000);
});

// ═══ S37 · increderea ═════════════════════════════════════════════════════
await scena('s37-incredere', async () => {
  await intra('date', 1600);
  await curata(); await derulare(300, 1800);
  await card('De ce poți avea încredere', 'Validat cu validatorul\npublicat de ANAF',
    'peste 5.200 de verificări automate la fiecare versiune\nbackup zilnic, cu copie în afara serverului', 8000);
});

// ═══ S38 · limitele, cinstit ══════════════════════════════════════════════
await scena('s38-limite', async () => {
  await card('Ce rămâne la voi', 'Cinstit, până la capăt',
    'depunerea în SPV, cu certificatul digital al firmei\nvalidarea finală, cu DUKIntegrator\ncasa de marcat rămâne obligatorie separat\nbilanțul cere semnătura contabilului autorizat', 20000);
});

// ═══ S39 · final ══════════════════════════════════════════════════════════
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
