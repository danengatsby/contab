'use strict';

// Genereaza iconitele PWA (PNG) din culorile de brand, fara nicio biblioteca de imagini:
// encoder PNG propriu (IHDR + IDAT deflatat cu zlib + IEND, RGBA). Reproductibil — ruleaza
// `node scripts/gen-icons.js` dupa o schimbare de culoare/marca. Marca: grila 2x2 alba (evoca
// favicon-ul ▦ si registrul contabil), in zona centrala sigura (supravietuieste mastii circulare).

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const ACCENT = [0xc2, 0x61, 0x3c]; // --accent
const WHITE = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function png(size, draw) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b]) => { const o = (y * size + x) * 4; px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255; };
  draw(set, size);
  // scanlines cu byte de filtru 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// markFrac = cat de mare e grila (fractie din latura). Mai mic pentru maskable (zona sigura).
function drawIcon(markFrac) {
  return (set, size) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, ACCENT);
    const m = Math.round(size * markFrac);       // latura grilei
    const off = Math.round((size - m) / 2);      // centrare
    const gap = Math.max(2, Math.round(m * 0.12)); // spatiul dintre patrate
    const cell = Math.round((m - gap) / 2);
    for (const cy of [0, 1]) for (const cx of [0, 1]) {
      const x0 = off + cx * (cell + gap); const y0 = off + cy * (cell + gap);
      for (let y = y0; y < y0 + cell; y++) for (let x = x0; x < x0 + cell; x++) set(x, y, WHITE);
    }
  };
}

const out = path.join(__dirname, '..', 'public');
fs.writeFileSync(path.join(out, 'icon-192.png'), png(192, drawIcon(0.58)));
fs.writeFileSync(path.join(out, 'icon-512.png'), png(512, drawIcon(0.58)));
fs.writeFileSync(path.join(out, 'icon-maskable.png'), png(512, drawIcon(0.44))); // marca mai mica -> supravietuieste mastii
console.log('iconite generate: icon-192.png, icon-512.png, icon-maskable.png');
