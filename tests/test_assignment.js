// Developer-only. Checks that every character was given the RIGHT marks (not just that 72 were found).
// All the fake sheets drawn with the same computer handwriting font should give each character about the same
// ink area (in font units). A shifted or mixed-up reading shows up as characters with the wrong size.
//   node tests/test_assignment.js [sheetName ...]      (run after making the sheets; one at a time is fine)
const { loadAll, readRgba } = require("./load");
const HF = loadAll();

function areas(name) {
  const r = HF.reader.read(readRgba(name));
  if (!r.ok) return null;
  const out = {};
  Object.keys(r.glyphs).forEach((ch) => {
    const g = r.glyphs[ch];
    let px = 0;
    for (let i = 0; i < g.mask.length; i++) px += g.mask[i];
    out[ch] = px * g.f * g.f;
  });
  return out;
}

const ref = areas("clean_ink");
const names = process.argv.slice(2).length ? process.argv.slice(2) : ["stray", "no_comma", "tilt", "shadow", "table", "persp_top", "persp_side", "persp_both", "persp_hard", "blur_light"];
let bad = 0;
for (const name of names) {
  const a = areas(name);
  if (!a) { console.log(`${name.padEnd(12)} reader did not succeed`); bad++; continue; }
  const off = [];
  HF.charset.ORDER.forEach((ch) => {
    const ratio = a[ch] / ref[ch];
    if (!(ratio > 0.6 && ratio < 1.6)) off.push(`${ch} (${ratio.toFixed(2)})`);
  });
  const flag = off.length > 3 ? "  <-- WRONG ASSIGNMENT" : "";
  if (flag) bad++;
  console.log(`${name.padEnd(12)} ${off.length} of 72 characters look the wrong size${off.length ? ": " + off.join(" ") : ""}${flag}`);
}
console.log(bad ? `\n${bad} sheet(s) look mis-assigned` : "\nall characters were given the right marks");
process.exit(bad ? 1 : 0);
