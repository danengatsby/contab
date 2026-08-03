// ─────────────────────────────────────────────────────────────────────────────
//  INREGISTRAREA videoului de prezentare — scenariul e in docs/scenariu-video-prezentare.md.
//
//  Playwright inregistreaza NATIV (webm), fara ffmpeg pe gazda. Ce nu face singur: cursorul real
//  NU apare in inregistrare, deci se deseneaza unul fals care se plimba spre fiecare tinta —
//  altfel lucrurile par ca se intampla singure.
//
//  RETETA (instanta IZOLATA cu exemplul din ghid, NU demoul public — vezi antetul lui
//  scripts/capturi-marketing.mjs pentru motiv):
//
//    S=/tmp/video
//    export CONTAB_DEV=1 CONTAB_DB_DRIVER=sqlite CONTAB_DB_FILE=$S/vid.json \
//           CONTAB_DATA_DIR=$S/vid-data CONTAB_JSON_MIRROR=0 STRIPE_SECRET_KEY=''
//    node scripts/seed.js                       # firma-exemplu, date pe 2026-06
//    PORT=18099 HOST=127.0.0.1 node server.js &
//    # parola contului admin se schimba o data (contul de seed porneste cu admin/admin):
//    #   POST /api/change-password { oldPassword: 'admin', newPassword: <VIDEO_PW> }
//    mkdir -p $S/out && cp scripts/video-prezentare.mjs $S/film.mjs
//    docker run --rm --network host -v $S:/w -w /w mcr.microsoft.com/playwright:v1.58.2-noble \
//      sh -c "npm i --no-save playwright@1.58.2 >/dev/null 2>&1 && node film.mjs"
//    # -> $S/out/<hash>.webm  (~3 minute, 1280x720)
//
//  Conversia in mp4 si contactul de verificare se fac tot in container, cu ffmpeg-static
//  (`npm i --no-save ffmpeg-static`), fiindca pe gazda nu exista ffmpeg:
//    ffmpeg -ss 5 -i <webm> -c:v libx264 -crf 21 -pix_fmt yuv420p -vsync cfr -r 25 \
//           -movflags +faststart contabo-prezentare-720p.mp4
//    ffmpeg -i contabo-prezentare-720p.mp4 -vf "fps=1/8,scale=384:-1,tile=5x5" -frames:v 1 contact.jpg
//  (`-ss 5` taie autentificarea de la inceput; `contact.jpg` = tot filmul intr-o singura imagine,
//  singurul mod de a VERIFICA rezultatul fara sa te uiti la el trei minute.)
//
//  DOUA ESECURI TACUTE, ambele intalnite aici si ambele reparate mai jos:
//    1. CSP-ul aplicatiei (`style-src 'self'`, fara unsafe-inline) BLOCHEAZA <style>-ul injectat —
//       prima inregistrare a iesit fara cartoane si fara cursor, dar fara nicio eroare. De aceea
//       contextul se creeaza cu `bypassCSP: true`.
//    2. Cartonul de titlu ramane in DOM intre scene (opacity 0) si, fara `pointer-events:none`,
//       INGHITE clicurile: formularul nu se mai deschidea, iar pasii raportau tot „reusit".
//  De aici si regula: fiecare pas isi raporteaza starea (`pas()`), iar rezultatul se verifica
//  pe contactul de imagini, nu pe log.
// ─────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18099';
const PW = process.env.VIDEO_PW || 'VideoDemo2026x';
const W = 1280; const H = 720;

const b = await chromium.launch();
// bypassCSP: aplicatia are `style-src 'self'` (fara unsafe-inline), deci <style>-ul injectat pentru
// cartoanele de titlu si cursorul fals era BLOCAT tacut — prima inregistrare a iesit fara ele.
// Se dezactiveaza DOAR in sesiunea de filmare; produsul ramane neatins.
const ctx = await b.newContext({ bypassCSP: true, viewport: { width: W, height: H }, recordVideo: { dir: '/w/out', size: { width: W, height: H } } });
const pg = await ctx.newPage();
const jurnal = [];
const pas = async (nume, fn) => {
  try { await fn(); jurnal.push('  ✓ ' + nume); } catch (e) { jurnal.push('  ✗ ' + nume + ' — ' + String(e.message).split('\n')[0].slice(0, 90)); }
};
const asteapta = (ms) => pg.waitForTimeout(ms);

// ── autentificare ──────────────────────────────────────────────────────────
await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('#loginForm [name=username]', { state: 'visible' });
await pg.fill('#loginForm [name=username]', 'admin');
await pg.fill('#loginForm [name=password]', PW);
await pg.press('#loginForm [name=password]', 'Enter');
await asteapta(3000);
await pg.evaluate(() => document.querySelectorAll('#welcomeOverlay,.toast,#tourCard').forEach((e) => e.remove()));

// ── pregatire: luna de lucru pe datele exemplului (2026-06), INAINTE de unelte ─────
await pg.evaluate(() => {
  try {
    localStorage.setItem('contab_workmonth', '2026-06');
    localStorage.setItem('contab_welcomed_admin', '1');   // fara ecranul de bun-venit in cadru
    localStorage.setItem('contab_tour_v1_admin', '1');    // si fara turul care porneste singur
  } catch (e) {}
});
await pg.reload({ waitUntil: 'domcontentloaded' });
await asteapta(3200);
await pg.evaluate(() => document.querySelectorAll('#welcomeOverlay,.toast,#tourCard').forEach((e) => e.remove()));

// ── unelte de filmare: cursor fals, evidentiere, cartoane de titlu ─────────
await pg.evaluate(() => {
  const s = document.createElement('style');
  s.textContent = `
    #__cur{position:fixed;z-index:2147483646;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;
      background:rgba(240,193,75,.28);border:2px solid #f0c14b;pointer-events:none;left:50%;top:55%;
      transition:left .55s cubic-bezier(.4,0,.2,1),top .55s cubic-bezier(.4,0,.2,1),transform .18s}
    #__cur.apasa{transform:scale(.55);background:rgba(240,193,75,.6)}
    .__tinta{outline:3px solid #f0c14b !important;outline-offset:2px;border-radius:8px;transition:outline-color .2s}
    /* pointer-events:none — cartonul ramane in DOM cu opacity 0 intre scene si, altfel,
       INGHITE clicurile: prima incercare a esuat asa, tacut (formularul nu se mai deschidea). */
    #__card{pointer-events:none;position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;
      justify-content:center;gap:14px;background:#14120f;color:#f6f1e7;opacity:0;transition:opacity .45s;
      font-family:Georgia,'Times New Roman',serif;text-align:center;padding:0 8%}
    #__card.on{opacity:1}
    #__card b{white-space:pre-line;font-size:52px;line-height:1.15;letter-spacing:-.5px}
    #__card span{font-size:24px;color:#c9bfae;font-family:system-ui,sans-serif}
    #__card i{font-size:19px;color:#f0c14b;font-style:normal;letter-spacing:2px;text-transform:uppercase}`;
  document.head.appendChild(s);
  const c = document.createElement('div'); c.id = '__cur'; document.body.appendChild(c);
  const k = document.createElement('div'); k.id = '__card'; k.innerHTML = '<i></i><b></b><span></span>'; document.body.appendChild(k);
  window.__card = (sus, titlu, jos) => {
    const k2 = document.querySelector('#__card');
    k2.querySelector('i').textContent = sus || '';
    k2.querySelector('b').textContent = titlu || '';
    k2.querySelector('span').textContent = jos || '';
    k2.classList.add('on');
  };
  window.__cardOff = () => document.querySelector('#__card').classList.remove('on');
  window.__cur = (x, y) => { const c2 = document.querySelector('#__cur'); c2.style.left = x + 'px'; c2.style.top = y + 'px'; };
  window.__apasa = () => { const c2 = document.querySelector('#__cur'); c2.classList.add('apasa'); setTimeout(() => c2.classList.remove('apasa'), 220); };
});

const card = async (sus, titlu, jos, ms = 2600) => {
  await pg.evaluate(([a, b2, c]) => window.__card(a, b2, c), [sus, titlu, jos]);
  await asteapta(ms);
  await pg.evaluate(() => window.__cardOff());
  await asteapta(700);
};
/** Muta cursorul fals peste element, il evidentiaza, apoi da clic real. */
const clic = async (sel, { evidentiaza = true, dupa = 900 } = {}) => {
  const el = pg.locator(sel).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const box = await el.boundingBox();
  if (box) {
    await pg.evaluate(([x, y]) => window.__cur(x, y), [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]);
    await asteapta(650);
  }
  if (evidentiaza) { await el.evaluate((e) => e.classList.add('__tinta')).catch(() => {}); await asteapta(350); }
  await pg.evaluate(() => window.__apasa());
  await el.click({ force: true });
  if (evidentiaza) await el.evaluate((e) => e.classList.remove('__tinta')).catch(() => {});
  await asteapta(dupa);
};
/**
 * Intra pe o pagina: cursorul se plimba pe intrarea din meniu, apoi navigarea se face prin
 * `window.goTab` — nu prin clic DOM. Motivul, intalnit la prima inregistrare: dupa ce pagina e
 * derulata in jos, clicul pe a doua intrare a unui grup deja deschis pica cu „Element is not
 * visible", desi omul o vede. Pentru film conteaza ce se VEDE, nu prin ce mecanism se navigheaza.
 */
const intra = async (tab, dupa = 2000) => {
  const el = pg.locator('#tabs button[data-tab="' + tab + '"]').first();
  const box = await el.boundingBox().catch(() => null);
  if (box) {
    await pg.evaluate(([x, y]) => window.__cur(x, y), [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]);
    await asteapta(600);
    await el.evaluate((e) => e.classList.add('__tinta')).catch(() => {});
    await asteapta(320);
  }
  await pg.evaluate(() => window.__apasa());
  await pg.evaluate((t) => window.goTab(t), tab);
  if (box) await el.evaluate((e) => e.classList.remove('__tinta')).catch(() => {});
  await asteapta(dupa);
};
/** Deschide un grup din meniu si intra pe o pagina. */
const meniu = async (grup, tab, dupa = 1600) => {
  const lbl = pg.locator('#tabs .navlabel', { hasText: grup }).first();
  const deschis = await lbl.evaluate((e) => e.closest('.navgroup').classList.contains('open')).catch(() => false);
  if (!deschis) await clic('#tabs .navlabel:has-text("' + grup + '")', { dupa: 900 });
  await intra(tab, dupa);
};
const curata = () => pg.evaluate(() => document.querySelectorAll('.toast,#welcomeOverlay,#tourCard').forEach((e) => e.remove()));
const derulare = async (px, ms = 1400) => {
  await pg.evaluate((p) => window.scrollTo({ top: p, behavior: 'smooth' }), px);
  await asteapta(ms);
};

// ── SCENA 0 · titlu ────────────────────────────────────────────────────────
await pas('carton intro', async () => {
  await card('Contabo', 'Contabilitatea firmei tale,\nde la poză la declarație', 'contabilitate românească · partidă dublă · parametri fiscali 2026', 3400);
});

// ── SCENA 1 · Acasa ────────────────────────────────────────────────────────
await pas('acasa', async () => {
  await intra('dashboard', 2200);
  await curata();
  await derulare(420, 1800);
  await derulare(0, 1200);
});

// ── SCENA 2 · documentul primit ────────────────────────────────────────────
await pas('carton documente', () => card('Pasul 1', 'Documentele', 'ce intră și ce iese din firmă', 2400));
await pas('adauga document', async () => {
  await meniu('Documente', 'documente', 2000);
  await curata();
  await derulare(260, 1500);
  await clic('#manualBtn', { dupa: 1400 });
  await derulare(320, 1000);
});
await pas('alege tipul', async () => {
  await clic('#tipSelect', { dupa: 500 });
  await pg.selectOption('#tipSelect', { label: /Factura cumparare marfuri|Factură cumpărare mărfuri/ }).catch(async () => {
    const v = await pg.evaluate(() => { const o = [...document.querySelectorAll('#tipSelect option')].find((x) => /cumparare marfuri|cumpărare mărfuri/i.test(x.textContent)); return o ? o.value : ''; });
    if (v) await pg.selectOption('#tipSelect', v);
  });
  await asteapta(1600);
});
await pas('completeaza documentul', async () => {
  const scrie = async (nume, txt) => {
    const el = pg.locator('#dynFields [name="' + nume + '"]').first();
    if (!(await el.count())) return;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const box = await el.boundingBox();
    if (box) { await pg.evaluate(([x, y]) => window.__cur(x, y), [Math.round(box.x + 30), Math.round(box.y + box.height / 2)]); await asteapta(420); }
    await el.click({ force: true });
    await el.fill('');
    await el.type(txt, { delay: 60 });
    await asteapta(300);
  };
  await scrie('data', '2026-06-18');
  await scrie('partener', 'ALFA DISTRIBUTIE SRL');
  await scrie('cuiPartener', '11223342');
  await scrie('document', 'FF 2214');
  await scrie('baza', '1000');
  await pg.locator('#dynFields [name="baza"]').first().press('Tab').catch(() => {});
  await asteapta(2600);              // previzualizarea articolului contabil vine de la SERVER
  await derulare(620, 1600);
  await asteapta(2200);
});
await pas('salveaza documentul', async () => {
  await clic('#entryForm button[type="submit"]', { dupa: 2600 });
  await curata();
  await intra('intrate', 2600);
  await curata();
  await derulare(280, 1800);
});

// ── SCENA 2b · factura emisa ───────────────────────────────────────────────
await pas('carton emite', () => card('Pasul 1 · partea a doua', 'Factura pe care o emiți', 'PDF pentru client · e-Factura pentru SPV', 2400));
await pas('emite factura', async () => {
  await intra('emite', 2600);
  await curata();
  await derulare(300, 1800);
  await derulare(700, 1800);
  await derulare(0, 900);
});

// ── SCENA 3 · banii ────────────────────────────────────────────────────────
await pas('carton bani', () => card('Pasul 2', 'Banii', 'încasări, plăți și extrasul bancar', 2400));
await pas('cashbook', async () => {
  await meniu('Bani', 'cashbook', 2000);
  await curata(); await derulare(260, 1500); await derulare(0, 900);
});
await pas('reconciliere', async () => { await intra('reconciliere', 2200); await curata(); await derulare(300, 1500); });

// ── SCENA 4 · ce misca lunar ───────────────────────────────────────────────
await pas('carton lunar', () => card('Pasul 3', 'Ce mișcă în fiecare lună', 'stocuri · salarii · amortizare', 2400));
await pas('stocuri', async () => { await meniu('Stocuri', 'stocuri', 2000); await curata(); await derulare(300, 1500); });
await pas('salarii', async () => { await meniu('Salarii', 'salarizare', 2200); await curata(); await derulare(280, 1600); await derulare(0, 900); });
await pas('mijloace fixe', async () => { await meniu('Mijloace fixe', 'mijloace', 2200); await curata(); await derulare(240, 1500); });

// ── SCENA 5 · registrele ───────────────────────────────────────────────────
await pas('carton registre', () => card('Pasul 4', 'Registrele se scriu singure', 'jurnal · cartea mare · balanță', 2400));
await pas('jurnal', async () => { await meniu('Registre', 'jurnal', 2000); await curata(); await derulare(300, 1400); });
await pas('balanta', async () => { await intra('balanta', 2400); await curata(); await derulare(420, 1800); });

// ── SCENA 6 · inchiderea lunii ─────────────────────────────────────────────
await pas('carton inchidere', () => card('Pasul 5', 'Închiderea lunii', 'starea fiecărui pas se calculează din date', 2800));
await pas('inchiderea lunii', async () => {
  await meniu('Închideri', 'inchideri', 2600);
  await curata();
  await derulare(300, 1800); await derulare(700, 1800); await derulare(1100, 1800);
});

// ── SCENA 7 · taxe si declaratii ───────────────────────────────────────────
await pas('carton taxe', () => card('Pasul 6', 'Taxele și declarațiile', 'D300 · D394 · D112 · SAF-T', 2400));
await pas('tva', async () => { await meniu('Taxe', 'tva', 2400); await curata(); await derulare(320, 1600); await derulare(0, 900); });
await pas('declaratii', async () => { await intra('livrabile', 2600); await curata(); await derulare(360, 1800); });
await pas('saft', async () => { await intra('saft', 2400); await curata(); await derulare(300, 1500); });

// ── SCENA 8 · rapoarte ─────────────────────────────────────────────────────
await pas('carton rapoarte', () => card('Pasul 7', 'Cum stă firma', 'bilanț, profit și pierdere, scadențar', 2400));
await pas('situatii', async () => { await meniu('Rapoarte', 'situatii', 2600); await curata(); await derulare(340, 1800); await derulare(0, 900); });

// ── SCENA 9 · incredere + final ────────────────────────────────────────────
await pas('carton incredere', () => card('De ce poți avea încredere',
  'Validat cu validatorul\npublicat de ANAF', 'peste 4.600 de verificări automate la fiecare versiune', 3200));
await pas('carton final', () => card('30 de zile gratuit, fără card', 'contabo.space', 'aduci documentele — Contabo face contabilitatea', 3600));

console.log(jurnal.join('\n'));
await ctx.close();   // videoul se scrie la inchiderea contextului
await b.close();
