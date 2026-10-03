// Developer-only. Builds a sample PDF from the saved library and checks its structure.
//   node tests/test_pdf.js [name]      (default clean_ink; run test_font.js first)
const fs = require("fs");
const path = require("path");
const { loadAll } = require("./load");

const HF = loadAll();
const name = process.argv[2] || "clean_ink";
const lib = JSON.parse(fs.readFileSync(path.join(__dirname, "out", name + ".library.json"), "utf8"));
let bad = 0;
function ok(cond, msg) { if (!cond) { bad++; console.log("  PROBLEM:", msg); } }

const page = HF.layout.PAGES.card;
const note = "Dear friend, I wish I could hand you this note in person. Since I can't, I wrote it in my own handwriting instead. Miss you lots.";
const layout = HF.layout.layoutText(note, lib, { pageW: page.w, pageH: page.h, size: HF.layout.defaultSize("card", 5), seed: 3 });
const pdf = HF.pdfwriter.buildPDF({ pageW: page.w, pageH: page.h, layout, lib, ink: "#14284b", paper: "#fbf4e4", lines: true, title: "Test card" });
const file = path.join(__dirname, "out", name + ".card.pdf");
fs.writeFileSync(file, pdf);
console.log(`wrote ${file} (${pdf.length} bytes, ${layout.glyphs.length} glyphs)`);

// structure checks: header, xref offsets really point at "N 0 obj", stream lengths match, startxref is right
const s = Buffer.from(pdf).toString("latin1");
ok(s.startsWith("%PDF-1.4"), "header");
ok(s.trimEnd().endsWith("%%EOF"), "trailer end");
const sx = /startxref\n(\d+)\n%%EOF/.exec(s);
ok(sx && s.substr(+sx[1], 4) === "xref", "startxref does not point at the xref table");
const count = +/xref\n0 (\d+)\n/.exec(s)[1];
const rows = s.substr(+sx[1]).split("\n").slice(2, 2 + count);
rows.slice(1).forEach((row, i) => {
  const off = parseInt(row.slice(0, 10), 10);
  ok(s.substr(off, String(i + 1).length + 6) === `${i + 1} 0 obj`, `xref entry ${i + 1} points to the wrong place`);
});
const streams = [...s.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
streams.forEach((m, i) => ok(+m[1] === m[2].length, `stream ${i} length ${m[1]} != ${m[2].length}`));
const forms = (s.match(/\/Subtype \/Form/g) || []).length;
const distinct = new Set(layout.glyphs.map((g) => g.ch)).size;
ok(forms === distinct, `expected ${distinct} glyph forms, found ${forms}`);
ok((s.match(/ Do Q/g) || []).length === layout.glyphs.length, "number of drawn glyphs");
ok(!/NaN|Infinity|undefined/.test(s), "NaN / undefined in the PDF text");
console.log(bad ? `\n${bad} problem(s)` : "\nPDF structure looks right");
process.exit(bad ? 1 : 0);
