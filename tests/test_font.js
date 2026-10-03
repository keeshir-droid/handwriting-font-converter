// Developer-only. Reader -> tracer -> library -> .ttf for ONE sheet, saved to tests/out/<name>.ttf.
// Then run:  python tests/validate_font.py <name>
//   node tests/test_font.js [sheetName]      (default clean_ink)
const fs = require("fs");
const path = require("path");
const { loadAll, readRgba } = require("./load");

const HF = loadAll();
const name = process.argv[2] || "clean_ink";
const r = HF.reader.read(readRgba(name));
if (!r.ok) { console.log("reader failed:", r.errors.map((e) => e.title).join(" | ")); process.exit(1); }

const lib = HF.library.build(r);
const ttf = HF.fontwriter.buildTTF({ familyName: "Test Hand " + name, glyphs: lib.glyphs, aliases: lib.aliases });
const out = path.join(__dirname, "out", name + ".ttf");
fs.writeFileSync(out, ttf);
fs.writeFileSync(path.join(__dirname, "out", name + ".library.json"), JSON.stringify(lib));
console.log(`wrote ${out} (${ttf.length} bytes, ${Object.keys(lib.glyphs).length} glyphs, ${Object.keys(lib.aliases).length} aliases)`);
