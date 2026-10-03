// Developer-only. Draws what the reader sees (ink mask + group boxes) so a bad photo can be diagnosed.
//   node tests/dump_mask.js <sheetName>   -> tests/out/<name>.mask.ppm  (convert with PIL)
const fs = require("fs");
const path = require("path");
const { loadAll, readRgba } = require("./load");
const HF = loadAll();
const name = process.argv[2];
const r = HF.reader.read(readRgba(name), { debug: true });
const d = r.debug;
if (!d) { console.log("no debug info (stopped early):", r.errors.map((e) => e.title).join(" | ")); process.exit(1); }
const { w, h, mask, groups, rows } = d;
const img = Buffer.alloc(w * h * 3, 255);
for (let i = 0; i < w * h; i++) if (mask[i]) { img[i * 3] = 20; img[i * 3 + 1] = 20; img[i * 3 + 2] = 20; }
function box(g, c) {
  for (let x = g.x0 - 2; x <= g.x1 + 2; x++) for (const y of [g.y0 - 2, g.y1 + 2]) { if (x >= 0 && y >= 0 && x < w && y < h) { const o = (y * w + x) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; } }
  for (let y = g.y0 - 2; y <= g.y1 + 2; y++) for (const x of [g.x0 - 2, g.x1 + 2]) { if (x >= 0 && y >= 0 && x < w && y < h) { const o = (y * w + x) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; } }
}
const palette = [[220, 40, 40], [40, 120, 220], [30, 160, 80], [220, 140, 0], [150, 50, 200], [0, 170, 170]];
rows.forEach((row, ri) => row.forEach((g) => box(g, palette[ri % palette.length])));
fs.writeFileSync(path.join(__dirname, "out", name + ".mask.ppm"), Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), img]));
console.log(`hRef=${d.hRef} groups=${groups.length} rows=${rows.length} size=${w}x${h}`);
rows.forEach((row, i) => console.log(` row ${i}: ${row.length} groups, y~${Math.round(row.reduce((a, g) => a + g.cy, 0) / row.length)}`));
