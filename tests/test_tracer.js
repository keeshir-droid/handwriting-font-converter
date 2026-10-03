// Developer-only. Reads one fake sheet, traces every glyph, checks the outlines, saves the library.
//   node tests/test_tracer.js [sheetName]        (default clean_ink; ONE sheet at a time)
const fs = require("fs");
const path = require("path");
const { loadAll, readRgba } = require("./load");

const HF = loadAll();
const name = process.argv[2] || "clean_ink";
const r = HF.reader.read(readRgba(name));
if (!r.ok) { console.log("reader failed:", r.errors.map((e) => e.title).join(" | ")); process.exit(1); }

const lib = {};
let bad = 0;
function complain(ch, msg) { bad++; console.log(`  problem with "${ch}": ${msg}`); }

const t0 = Date.now();
const all = Object.assign({}, r.glyphs);
all[","] = r.comma;
for (const ch of Object.keys(all)) {
  const g = all[ch];
  const t = HF.tracer.traceGlyph(g, g.f);
  lib[ch] = t;
  if (!t.contours.length) { complain(ch, "no outline"); continue; }
  const b = HF.outline.bounds(t.contours);
  let finite = true;
  t.contours.forEach((c) => c.forEach((p) => { if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) finite = false; }));
  if (!finite || !Number.isFinite(t.adv)) { complain(ch, "NaN in outline"); continue; }

  const item = HF.charset.ITEMS.find((i) => i.ch === ch);
  if (item && item.baselineOK && Math.abs(b.y0) > 50) complain(ch, `sits off the baseline (bottom at ${b.y0.toFixed(0)})`);
  if (item && item.capRef && (b.y1 < 540 || b.y1 > 960)) complain(ch, `capital height off (top at ${b.y1.toFixed(0)}, want ~700)`);

  // traced ink area should match the pixel count
  let maskPx = 0;
  for (let i = 0; i < g.mask.length; i++) maskPx += g.mask[i];
  const wantArea = maskPx * g.f * g.f;
  let gotArea = 0;
  t.contours.forEach((c) => { gotArea -= HF.outline.area(c); }); // outer = clockwise = negative area
  const ratio = gotArea / wantArea;
  if (ratio < 0.8 || ratio > 1.2) complain(ch, `ink area off (traced/pixels = ${ratio.toFixed(2)})`);
  if (gotArea <= 0) complain(ch, "outlines point the wrong way (outer contours must be clockwise)");
}
const ms = Date.now() - t0;

const missing = HF.charset.ORDER.concat([","]).filter((c) => !lib[c]);
if (missing.length) { bad++; console.log("  missing from library:", missing.join(" ")); }
let pts = 0, curves = 0, contours = 0;
Object.values(lib).forEach((g) => g.contours.forEach((c) => { contours++; pts += c.length; curves += c.filter((p) => !p.on).length; }));
console.log(`${name}: traced ${Object.keys(lib).length} glyphs in ${ms}ms, ${contours} contours, ${pts} points (${curves} off-curve)`);

fs.writeFileSync(path.join(__dirname, "out", name + ".lib.json"), JSON.stringify(lib));
console.log(bad ? `\n${bad} problem(s)` : "\nall glyphs look right");
process.exit(bad ? 1 : 0);
