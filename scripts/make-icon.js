// Generates build/icon.png (512x512) without external dependencies.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const SS = 4; // supersampling
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const BLUE = hex('#336791'); // PostgreSQL official blue
const WHITE = [255, 255, 255];
const HW = 23; // half stroke width of the letters

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
}
// distance from point to segment
function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Letter geometry (stroke centre lines), 512x512 canvas
const OX = -4; // horizontal centring offset
const TOPY = 154, BOTY = 358;
const M = [
  [[92, BOTY], [92, TOPY]],
  [[92, TOPY], [160, 292]],
  [[160, 292], [228, TOPY]],
  [[228, TOPY], [228, BOTY]],
].map((sg) => sg.map(([x, y]) => [x + OX, y]));
const PX = 304 + OX, BOWL_R = 56, BOWL_CX = 370 + OX, BOWL_CY = TOPY + BOWL_R;
const P = [
  [[PX, BOTY], [PX, TOPY]],
  [[PX, TOPY], [BOWL_CX, TOPY]],
  [[PX, TOPY + 2 * BOWL_R], [BOWL_CX, TOPY + 2 * BOWL_R]],
];

function inLetters(x, y) {
  for (const sg of [...M, ...P]) if (segDist(x, y, sg[0], sg[1]) <= HW) return true;
  // right half of the P bowl
  if (x >= BOWL_CX && Math.abs(Math.hypot(x - BOWL_CX, y - BOWL_CY) - BOWL_R) <= HW) return true;
  return false;
}

function sample(x, y) {
  if (!inRoundRect(x, y, 16, 16, 496, 496, 100)) return null;
  return inLetters(x, y) ? WHITE : BLUE;
}

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let py = 0; py < S; py++) {
  raw[py * (S * 4 + 1)] = 0;
  for (let px = 0; px < S; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
    const o = py * (S * 4 + 1) + 1 + px * 4;
    if (a) { raw[o] = r / a; raw[o + 1] = g / a; raw[o + 2] = b / a; }
    raw[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
