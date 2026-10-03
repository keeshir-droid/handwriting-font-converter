// Developer-only. Runs the photo reader on every fake sheet in tests/out and prints a report.
//   node tests/test_reader.js [name ...]
const fs = require("fs");
const path = require("path");
const { loadAll, readRgba } = require("./load");

const HF = loadAll();
const dir = path.join(__dirname, "out");
let names = process.argv.slice(2);
if (!names.length) names = fs.readdirSync(dir).filter((f) => f.endsWith(".rgba")).map((f) => f.replace(".rgba", ""));

// what we expect to happen for each fake photo
const EXPECT = {
  clean_ink: "ok", clean_script: "ok", clean_comic: "ok", tilt: "ok", shadow: "ok", table: "ok",
  blur_light: "ok", blur_heavy: "ok", no_comma: "fail", faint: "fail", small: "ok", stray: "fail",
  persp_top: "ok", persp_side: "ok", persp_both: "ok", persp_hard: "ok",
};

let bad = 0;
for (const name of names) {
  const img = readRgba(name);
  const t0 = Date.now();
  const r = HF.reader.read(img);
  const ms = Date.now() - t0;
  const q = r.stats.quality || {};
  const status = r.ok ? "ok" : "fail";
  const want = EXPECT[name];
  const flag = want && want !== status ? "  <-- UNEXPECTED" : "";
  if (flag) bad++;
  console.log(
    `${name.padEnd(14)} ${status.padEnd(5)} ${ms}ms  groups=${r.stats.groups} rows=${r.stats.rows} tilt=${(r.stats.tilt || 0).toFixed(1)} ` +
      `contrast=${(q.contrast || 0).toFixed(0)} sharp=${(q.sharpness || 0).toFixed(3)} shadow=${(q.shadow || 0).toFixed(2)}${flag}`
  );
  r.errors.forEach((e) => console.log("   ERROR:", e.title, e.detail));
  r.warnings.forEach((e) => console.log("   warn :", e.title));
  if (r.ok) {
    const missing = HF.charset.ORDER.filter((c) => !r.glyphs[c]);
    if (missing.length) { console.log("   missing glyphs:", missing.join("")); bad++; }
  }
}
console.log(bad ? `\n${bad} unexpected result(s)` : "\nall as expected");
process.exit(bad ? 1 : 0);
