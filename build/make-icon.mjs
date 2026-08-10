/**
 * Generates assets/icon.png (256px) and assets/icon.ico (multi-resolution)
 * without pulling in an image library.
 *
 * A rounded gradient tile with a clock face, rasterised by hand into an RGBA
 * buffer and wrapped in a minimal PNG container. Every dimension is expressed
 * as a fraction of the canvas, so the same code renders a crisp 16px tray icon
 * and a 256px Explorer icon. Run: node build/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));

/** Signed distance to a rounded rectangle, used for antialiased edges. */
function roundedRectDistance(x, y, w, h, r) {
  const qx = Math.abs(x) - (w - r);
  const qy = Math.abs(y) - (h - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function renderRGBA(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const k = size / 256; // scale factor: all constants below are tuned at 256px

  function setPixel(x, y, [r, g, b], alpha) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const a = Math.min(1, alpha);
    // Source-over onto whatever is already there.
    const dstA = px[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA === 0) return;
    px[i] = Math.round((r * a + px[i] * dstA * (1 - a)) / outA);
    px[i + 1] = Math.round((g * a + px[i + 1] * dstA * (1 - a)) / outA);
    px[i + 2] = Math.round((b * a + px[i + 2] * dstA * (1 - a)) / outA);
    px[i + 3] = Math.round(outA * 255);
  }

  // Background: rounded tile with a diagonal indigo → violet gradient.
  const from = [91, 124, 250];
  const to = [139, 92, 246];
  const half = size / 2;
  const margin = Math.max(1, 6 * k);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = roundedRectDistance(x - half + 0.5, y - half + 0.5, half - margin, half - margin, 52 * k);
      const coverage = clamp01(0.5 - d);
      if (coverage <= 0) continue;
      const t = clamp01((x + y) / (size * 2));
      setPixel(x, y, [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)], coverage);
    }
  }

  // Clock face: white ring.
  const cx = half - 0.5;
  const cy = half - 0.5;
  const ringOuter = 74 * k;
  const ringWidth = Math.max(1.5, 11 * k);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      const outer = clamp01(ringOuter - dist + 0.5);
      const inner = clamp01(dist - (ringOuter - ringWidth) + 0.5);
      const coverage = Math.min(outer, inner);
      if (coverage > 0) setPixel(x, y, [255, 255, 255], coverage);
    }
  }

  /** Thick antialiased line segment, for the hands. */
  function drawHand(angleDeg, length, width) {
    const rad = (angleDeg - 90) * (Math.PI / 180);
    const ex = cx + Math.cos(rad) * length;
    const ey = cy + Math.sin(rad) * length;
    const minX = Math.floor(Math.min(cx, ex) - width - 2);
    const maxX = Math.ceil(Math.max(cx, ex) + width + 2);
    const minY = Math.floor(Math.min(cy, ey) - width - 2);
    const maxY = Math.ceil(Math.max(cy, ey) + width + 2);
    const dx = ex - cx;
    const dy = ey - cy;
    const lenSq = dx * dx + dy * dy;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const t = clamp01(((x - cx) * dx + (y - cy) * dy) / lenSq);
        const nx = cx + dx * t;
        const ny = cy + dy * t;
        const dist = Math.hypot(x - nx, y - ny);
        const coverage = clamp01(width - dist + 0.5);
        if (coverage > 0) setPixel(x, y, [255, 255, 255], coverage);
      }
    }
  }

  drawHand(0, 42 * k, Math.max(1, 5.5 * k)); // minute hand, pointing up
  drawHand(115, 30 * k, Math.max(1, 5.5 * k)); // hour hand

  return px;
}

// --- PNG container ---------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePNG(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // bytes 10-12: deflate compression, adaptive filtering, no interlace (all 0)

  // Each scanline is prefixed with filter type 0 (none).
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    px.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- ICO container ---------------------------------------------------------

/**
 * Windows Vista and later accept PNG-compressed entries inside an .ico, which
 * avoids hand-rolling the legacy BMP+AND-mask encoding for every size.
 */
function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, i) => {
    const at = i * 16;
    directory[at] = entry.size >= 256 ? 0 : entry.size; // 0 means 256
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
}

// --- run -------------------------------------------------------------------

mkdirSync(join(root, "assets"), { recursive: true });

const entries = ICO_SIZES.map((size) => ({ size, png: encodePNG(renderRGBA(size), size) }));

const main = entries.find((e) => e.size === 256).png;
writeFileSync(join(root, "assets", "icon.png"), main);
console.log(`assets/icon.png — 256x256, ${(main.length / 1024).toFixed(1)} KB`);

const ico = encodeICO(entries);
writeFileSync(join(root, "assets", "icon.ico"), ico);
console.log(`assets/icon.ico — ${ICO_SIZES.join(", ")} px, ${(ico.length / 1024).toFixed(1)} KB`);
