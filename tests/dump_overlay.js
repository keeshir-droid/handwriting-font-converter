// Developer-only. Saves the straightened photo + the reader's labelled boxes: tests/out/<name>.overlay.json + .pgm
//   node tests/dump_overlay.js <sheetName>   then   python tests/draw_overlay.py <sheetName>
const fs = require("fs");
const path = require("path");
const { loadAll, readRgba } = require("./load");
const HF = loadAll();
const name = process.argv[2];
const r = HF.reader.read(readRgba(name), { debug: true });
const o = r.overlay;
if (!o) { console.log("no overlay:", r.errors.map((e) => e.title).join(" | ")); process.exit(1); }
fs.writeFileSync(path.join(__dirname, "out", name + ".overlay.pgm"), Buffer.concat([Buffer.from(`P5\n${o.w} ${o.h}\n255\n`), Buffer.from(o.gray)]));
fs.writeFileSync(path.join(__dirname, "out", name + ".overlay.json"), JSON.stringify({ w: o.w, h: o.h, boxes: o.boxes, ok: r.ok, errors: r.errors, stats: r.stats }));
console.log(`ok=${r.ok} boxes=${o.boxes.length} items=${o.boxes.filter((b) => b.kind === "item").length} commas=${o.boxes.filter((b) => b.kind === "comma").length} extras=${o.boxes.filter((b) => b.kind === "extra").length}`);
