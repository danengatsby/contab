// ─────────────────────────────────────────────────────────────────────────────
//  STAREA CI — verdictul GitHub Actions pentru commitul de pe disc, FARA `gh` si FARA token.
//
//  De ce exista: `gh` nu e autentificat pe serverul asta si fluxul lui de autentificare e
//  interactiv (cere un cod in browser), deci nu poate fi rulat dintr-o sesiune neinteractiva.
//  Dar depozitul e PUBLIC, iar API-ul GitHub raspunde neautentificat la citiri — deci verdictul
//  CI se poate afla oricum. Alternativa era ca rularile sa ramana nevazute de aici, adica exact
//  jobul `test-postgres` sa nu fie citit de nimeni: local se sare tacut fara `CONTAB_PG_URL`,
//  deci verdele de pe server nu spune nimic despre driverul de PRODUCTIE.
//
//  Rulare:  npm run stare-ci            # commitul de pe disc (HEAD)
//           npm run stare-ci <sha>      # un commit anume
//           npm run stare-ci main       # ultima rulare de pe o ramura
//
//  Coduri de iesire, aceeasi conventie ca la poarta fiscala si `npm run test-pg`:
//     0  verde   — rulare incheiata cu succes
//     1  ROSU    — rulare incheiata cu esec (sau anulata)
//     2  NEVERIFICAT — nicio rulare, rulare in curs, retea picata sau plafon de API atins.
//        „N-am putut verifica" NU e „e bine", si nu are voie sa semene cu el.
//
//  `GH_TOKEN`/`GITHUB_TOKEN` se folosesc DACA exista in mediu (plafon de API mai mare si acces la
//  depozite private), dar nu sunt necesare aici. Nu se citeste si nu se scrie niciun fisier de
//  configurare: scriptul nu depinde de starea de autentificare a nimanui.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const https = require('https');
const { execFileSync } = require('child_process');

// stderr-ul lui git se INGHITE: `git branch --contains <sha inexistent>` scrie „no such commit"
// direct pe terminal, iar mesajul aparea sub verdictul nostru ca si cum ar fi al scriptului.
const git = (...a) => {
  try { return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (e) { return null; }
};

/** owner/repo din remote-ul `origin` — nu scris de mana: o clona sau o redenumire l-ar face fals. */
function depozit() {
  const url = git('remote', 'get-url', 'origin');
  if (!url) return null;
  const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? m[1] + '/' + m[2] : null;
}

function cere(cale) {
  const antet = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'contab-stare-ci' };
  const tok = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (tok) antet.Authorization = 'Bearer ' + tok;
  return new Promise((rez, resp) => {
    const c = https.get('https://api.github.com' + cale, { headers: antet, timeout: 15000 }, (r) => {
      let b = '';
      r.on('data', (d) => { b += d; });
      r.on('end', () => {
        if (r.statusCode === 403 && r.headers['x-ratelimit-remaining'] === '0') {
          const cand = new Date(Number(r.headers['x-ratelimit-reset'] || 0) * 1000);
          return resp(new Error('plafon de API atins; se reia dupa ' + cand.toLocaleTimeString('ro-RO')));
        }
        if (r.statusCode !== 200) return resp(new Error('HTTP ' + r.statusCode + ' pe ' + cale));
        try { rez(JSON.parse(b)); } catch (e) { resp(new Error('raspuns necitibil de la API')); }
      });
    });
    c.on('timeout', () => { c.destroy(new Error('timeout la API')); });
    c.on('error', resp);
  });
}

const SEMN = { success: '✓', failure: '✗', cancelled: '⊘', skipped: '–', neutral: '·' };
const cat = (iso) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'acum ' + s + ' s';
  if (s < 5400) return 'acum ' + Math.round(s / 60) + ' min';
  if (s < 172800) return 'acum ' + Math.round(s / 3600) + ' h';
  return 'acum ' + Math.round(s / 86400) + ' zile';
};

async function main() {
  const repo = depozit();
  if (!repo) { console.error('Nu pot afla depozitul din `git remote get-url origin`.'); process.exit(2); }

  const arg = process.argv[2];
  const esteSha = arg && /^[0-9a-f]{7,40}$/i.test(arg);
  const sha = esteSha ? git('rev-parse', arg) || arg : (arg ? null : git('rev-parse', 'HEAD'));
  const ramura = arg && !esteSha ? arg : null;

  const q = sha ? '?head_sha=' + sha + '&per_page=5'
    : '?branch=' + encodeURIComponent(ramura) + '&per_page=5';
  const d = await cere('/repos/' + repo + '/actions/runs' + q);
  const rulari = d.workflow_runs || [];

  if (!rulari.length) {
    const scurt = (sha || ramura || '').slice(0, 7);
    console.log('NEVERIFICAT — nicio rulare CI pentru ' + scurt + ' in ' + repo + '.');
    if (sha) {
      const local = git('rev-parse', 'HEAD');
      const trimis = git('branch', '-r', '--contains', sha);
      if (sha === local && !trimis) console.log('  Commitul nu e pe niciun remote: `git push` intai.');
    }
    process.exit(2);
  }

  let cod = 0;
  for (const r of rulari) {
    const incheiat = r.status === 'completed';
    const verdict = incheiat ? (r.conclusion || '?') : r.status;
    console.log('\n%s · %s · %s (%s)', r.name, verdict.toUpperCase(), r.head_sha.slice(0, 7), cat(r.created_at));
    console.log('  %s', r.html_url);
    let joburi = [];
    try { joburi = (await cere(new URL(r.jobs_url).pathname)).jobs || []; } catch (e) { /* joburile sunt un plus */ }
    for (const j of joburi) {
      const v = j.status === 'completed' ? (j.conclusion || '?') : j.status;
      // `padEnd`, nu `%-24s`: `console.log` din Node cunoaste doar %s/%d/%j/%o — o forma printf
      // ramane text pe ecran, exact cum a si iesit la prima rulare.
      console.log('   ' + (SEMN[v] || '?') + ' ' + j.name.slice(0, 24).padEnd(24) + ' ' + v);
    }
    if (!incheiat) cod = Math.max(cod, 2);
    else if (r.conclusion !== 'success') cod = Math.max(cod, 1);
  }
  console.log('');
  if (cod === 0) console.log('CI VERDE.');
  else if (cod === 1) console.log('CI ROSU — vezi jobul picat mai sus.');
  else console.log('NEVERIFICAT — rulare inca in curs.');
  process.exit(cod);
}

main().catch((e) => {
  // Orice esec de retea/API e NEVERIFICAT (2), niciodata verde: altfel un DNS picat ar trece
  // drept „CI in regula" exact cand nu stii nimic.
  console.error('NEVERIFICAT — ' + e.message);
  process.exit(2);
});
