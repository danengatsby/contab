// ─────────────────────────────────────────────────────────────────────────────
//  MONTAJUL videoului: aseaza vocea peste inregistrare si scoate mp4-ul final.
//
//  Intrari:  out/<hash>.webm (de la scripts/video-prezentare.mjs) · out/timeline.json (offsetul
//            REAL al fiecarei scene) · tts/durate.json + tts/wav/*.wav (vocea, generata cu piper).
//  Iesiri:   out/contabo-prezentare-720p.mp4 · out/contact.jpg (un cadru din fiecare scena, in
//            grila — singurul mod de a VERIFICA rezultatul fara sa urmaresti filmul cap-coada) ·
//            out/poster.jpg.
//
//  Rulare (in containerul Playwright: pe gazda nu exista ffmpeg):
//    docker run --rm -v $S:/w -w /w -e OFFSET=1.5 mcr.microsoft.com/playwright:v1.58.2-noble \
//      sh -c "npm i --no-save ffmpeg-static >/dev/null 2>&1 && node mux.mjs"
//
//  OFFSET (secunde) intarzie TOATA vocea fata de imagine. Nu e un moft: intre inceputul unei scene
//  si ecranul ei trec ~1,5 s de navigare (cursorul se plimba, meniul se deschide), iar fara offset
//  vocea incepe sa descrie un ecran care inca nu se vede.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import ff from 'ffmpeg-static';
import fs from 'node:fs';

const tl = JSON.parse(fs.readFileSync('/w/out/timeline.json', 'utf8'));
const dur = JSON.parse(fs.readFileSync('/w/tts/durate.json', 'utf8'));
// Un context Playwright înregistrează și filele deschise accidental de linkuri `target=_blank`.
// Filmul principal este cel mai mare WebM; `find()` lua arbitrar primul nume din director și putea
// monta o filă secundară de câteva secunde în locul celor 26 de minute filmate.
const webm = fs.readdirSync('/w/out').filter((f) => f.endsWith('.webm'))
  .map((f) => ({ f, bytes: fs.statSync('/w/out/' + f).size }))
  .sort((a, b) => b.bytes - a.bytes);
if (!webm.length) throw new Error('Lipsește înregistrarea WebM din /w/out.');
const src = '/w/out/' + webm[0].f;
const OFFSET = Number(process.env.OFFSET || 0);   // calibrare fina video↔sunet
const MAX_GAP = Number(process.env.MAX_GAP || 1.5);

// Autentificarea între actorii demonstrației se petrece în afara scenelor vorbite. Păstrăm cel
// mult MAX_GAP secunde de tranziție; restul se taie împreună cu cronologia audio. Fără această
// compactare, o inițializare mai lentă ar lăsa 20–30 s de ecran static într-un film altfel corect.
const durata = Object.fromEntries(dur.map((d) => [d.id, Number(d.durata) || 0]));
const cuts = [];
for (let i = 0; i + 1 < tl.scene.length; i += 1) {
  const s = tl.scene[i]; const next = tl.scene[i + 1];
  const sfarsitScena = s.start + (durata[s.id] || 0) + 0.7;
  const gap = next.start - sfarsitScena;
  if (gap > MAX_GAP) cuts.push({ id: s.id, start: sfarsitScena + MAX_GAP, end: next.start, sec: gap - MAX_GAP });
}
const eliminatInainte = (sec) => cuts.reduce((n, c) => n + (c.end <= sec ? c.end - c.start : 0), 0);
const scene = tl.scene.map((s) => ({ ...s, start: s.start - eliminatInainte(s.start) }));

const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src];
const filtre = []; const etichete = [];
scene.forEach((s, i) => {
  const w = dur.find((d) => d.id === s.id);
  if (!w) return;
  // Calea se DERIVA din id, nu se citeste din fisierul de durate: o valoare cu prefix acolo
  // („tts/wav/x.wav") producea `/w/tts/tts/wav/x.wav` si montajul pica dupa 13 minute de
  // filmare — pretul unei cai duplicate platit la capatul celalalt al pipeline-ului.
  args.push('-i', '/w/tts/wav/' + s.id + '.wav');
  const ms = Math.max(0, Math.round((s.start + OFFSET) * 1000));
  filtre.push(`[${etichete.length + 1}:a]adelay=${ms}|${ms}[a${i}]`);
  etichete.push(`[a${i}]`);
});
filtre.push(`${etichete.join('')}amix=inputs=${etichete.length}:normalize=0:dropout_transition=0,volume=1.6,aresample=44100[aout]`);

if (cuts.length) {
  const intervale = []; let inceput = 0;
  cuts.forEach((c) => { intervale.push([inceput, c.start]); inceput = c.end; });
  intervale.push([inceput, null]);
  intervale.forEach(([start, end], i) => {
    filtre.push(`[0:v]trim=start=${start}${end == null ? '' : ':end=' + end},setpts=PTS-STARTPTS[vp${i}]`);
  });
  filtre.push(`${intervale.map((_, i) => `[vp${i}]`).join('')}concat=n=${intervale.length}:v=1:a=0[vcompact]`);
  filtre.push('[vcompact]tpad=stop_mode=clone:stop_duration=3[vout]');
} else {
  filtre.push('[0:v]tpad=stop_mode=clone:stop_duration=3[vout]');
}
args.push('-filter_complex', filtre.join(';'),
  '-map', '[vout]', '-map', '[aout]',
  // tpad: ultimul cadru (cartonul final) se tine inca 3 secunde — vocea intra cu OFFSET, deci
  // ultima replica ar fi fost taiata de sfarsitul inregistrarii.
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p', '-vsync', 'cfr', '-r', '25',
  '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
  '/w/out/contabo-prezentare-720p.mp4');
execFileSync(ff, args, { stdio: 'inherit' });

// contact: cate un cadru la 2 secunde DUPA startul fiecarei scene — asa se vede daca imaginea
// chiar corespunde vocii care se aude atunci
const run = (a) => execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
const CADRU = Number(process.env.CADRU || 3.5);
scene.forEach((s, i) => run(['-ss', String(s.start + OFFSET + CADRU), '-i', '/w/out/contabo-prezentare-720p.mp4', '-frames:v', '1', '-q:v', '4',
  `/w/out/c${String(i + 1).padStart(2, '0')}.jpg`]));
// Grila se calculeaza din NUMARUL de scene, nu e fixata la 5x5: altfel, orice scenariu cu peste
// 25 de scene ar fi taiat tacut finalul — adica exact partea de film neverificata.
const coloane = 5;
const linii = Math.ceil(tl.scene.length / coloane);
run(['-pattern_type', 'glob', '-i', '/w/out/c*.jpg', '-vf', `scale=384:-1,tile=${coloane}x${linii}`, '-frames:v', '1', '-q:v', '3', '/w/out/contact.jpg']);
// Posterul este chiar prima imagine reprezentativă a prezentării, nu secunda arbitrară 250 (care
// putea surprinde un meniu deschis sau un formular pe jumătate derulat după orice rescriere).
fs.copyFileSync('/w/out/c01.jpg', '/w/out/poster.jpg');
try { execFileSync(ff, ['-hide_banner', '-i', '/w/out/contabo-prezentare-720p.mp4'], { stdio: 'inherit' }); } catch (e) {}
console.log('Sursa video:', webm[0].f, Math.round(webm[0].bytes / 1048576) + ' MB');
if (cuts.length) {
  console.log('Tranziții compactate:', cuts.map((c) => `${c.id} −${c.sec.toFixed(1)}s`).join(', '));
  console.log('Timp static eliminat:', cuts.reduce((n, c) => n + c.sec, 0).toFixed(1), 's');
}
