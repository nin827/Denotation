// Writes the app icons into public/icons/ (node:zlib only, no packages): node tools/make-icons.mjs
// Mark: a bold "D" (outline) in light grey on a dark slate square. "any" icons fill most of the square; the maskable
// icon keeps the mark inside the central 60% safe zone, so any launcher mask can crop the corners.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BG = [0x1f, 0x25, 0x30];
const FG = [0xe6, 0xe9, 0xee];
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
export function png(size, pixel) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
// The D in unit space: height 2 (y -1..1), straight part 0.8 long, semicircle on the right; stroke 0.36.
const R = 1, LEFT = -0.9, CX = LEFT + 0.8, T = 0.36;
const inD = (x, y) => Math.abs(y) <= R && x >= LEFT && (x <= CX || Math.hypot(x - CX, y) <= R);
const inCounter = (x, y) => Math.abs(y) <= R - T && x >= LEFT + T && (x <= CX || Math.hypot(x - CX, y) <= R - T);
const onMark = (x, y) => inD(x, y) && !inCounter(x, y);
/** `fill`: fraction of the icon the mark's height takes. 4x4 supersampling for smooth edges. */
export function render(size, fill) {
  const scale = (size * fill) / 2; // px per unit
  const c = size / 2;
  const n = 4;
  return png(size, (px, py) => {
    let hit = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) hit += onMark((px + (i + 0.5) / n - c) / scale, (py + (j + 0.5) / n - c) / scale) ? 1 : 0;
    const a = hit / (n * n);
    return BG.map((b, k) => Math.round(b + (FG[k] - b) * a));
  });
}
export const svg = (fill) => {
  const s = 100 * fill / 2; // px per unit in a 100x100 box
  const pt = (x, y) => `${(50 + x * s).toFixed(2)} ${(50 + y * s).toFixed(2)}`;
  const shape = (l, r, cx) => `M${pt(l, -r)}H${(50 + cx * s).toFixed(2)}A${(r * s).toFixed(2)} ${(r * s).toFixed(2)} 0 0 1 ${pt(cx, r)}H${(50 + l * s).toFixed(2)}Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1f2530"/><path fill="#e6e9ee" fill-rule="evenodd" d="${shape(LEFT, R, CX)}${shape(LEFT + T, R - T, CX)}"/></svg>\n`;
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/icons");
  mkdirSync(dir, { recursive: true });
  const out = { "icon-192.png": render(192, 0.56), "icon-512.png": render(512, 0.56), "icon-maskable-512.png": render(512, 0.42), "apple-touch-icon.png": render(180, 0.56) };
  for (const [name, buf] of Object.entries(out)) writeFileSync(path.join(dir, name), buf);
  writeFileSync(path.join(dir, "icon.svg"), svg(0.56));
  console.log(`wrote ${Object.keys(out).length + 1} icons to ${dir}`);
}
