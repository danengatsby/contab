// ─────────────────────────────────────────────────────────────────────────────
//  MONTAJUL videoului: aseaza vocea peste inregistrare si scoate mp4-ul final.
//
//  Intrari:  out/<hash>.webm (de la scripts/video-prezentare.mjs) · out/timeline.json (offsetul
//            REAL al fiecarei scene) · tts/durate.json + tts/wav/*.wav (vocea, generata cu piper).
//  Iesiri:   out/contabo-prezentare-720p.mp4 · out/contact.jpg (un cadru din fiecare scena, in
//            grila — singurul mod de a VERIFICA rezultatul fara sa te uiti la el opt minute) ·
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
const src = '/w/out/' + fs.readdirSync('/w/out').find((f) => f.endsWith('.webm'));
const OFFSET = Number(process.env.OFFSET || 0);   // calibrare fina video↔sunet

const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src];
const filtre = []; const etichete = [];
tl.scene.forEach((s, i) => {
  const w = dur.find((d) => d.id === s.id);
  if (!w) return;
  args.push('-i', '/w/tts/' + w.wav.replace(/^wav\//, 'wav/'));
  const ms = Math.max(0, Math.round((s.start + OFFSET) * 1000));
  filtre.push(`[${filtre.length + 1}:a]adelay=${ms}|${ms}[a${i}]`);
  etichete.push(`[a${i}]`);
});
filtre.push(`${etichete.join('')}amix=inputs=${etichete.length}:normalize=0:dropout_transition=0,volume=1.6,aresample=44100[aout]`);
args.push('-filter_complex', filtre.join(';'),
  '-map', '0:v', '-map', '[aout]',
  // tpad: ultimul cadru (cartonul final) se tine inca 3 secunde — vocea intra cu OFFSET, deci
  // ultima replica ar fi fost taiata de sfarsitul inregistrarii.
  '-vf', 'tpad=stop_mode=clone:stop_duration=3',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p', '-vsync', 'cfr', '-r', '25',
  '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
  '/w/out/contabo-prezentare-720p.mp4');
execFileSync(ff, args, { stdio: 'inherit' });

// contact: cate un cadru la 2 secunde DUPA startul fiecarei scene — asa se vede daca imaginea
// chiar corespunde vocii care se aude atunci
const run = (a) => execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
const CADRU = Number(process.env.CADRU || 3.5);
tl.scene.forEach((s, i) => run(['-ss', String(s.start + OFFSET + CADRU), '-i', '/w/out/contabo-prezentare-720p.mp4', '-frames:v', '1', '-q:v', '4',
  `/w/out/c${String(i + 1).padStart(2, '0')}.jpg`]));
run(['-pattern_type', 'glob', '-i', '/w/out/c*.jpg', '-vf', 'scale=384:-1,tile=5x5', '-frames:v', '1', '-q:v', '3', '/w/out/contact.jpg']);
run(['-ss', '250', '-i', '/w/out/contabo-prezentare-720p.mp4', '-frames:v', '1', '-q:v', '2', '/w/out/poster.jpg']);
try { execFileSync(ff, ['-hide_banner', '-i', '/w/out/contabo-prezentare-720p.mp4'], { stdio: 'inherit' }); } catch (e) {}
