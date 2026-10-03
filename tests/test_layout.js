// Developer-only. Checks the page layout with the library saved by test_font.js.
//   node tests/test_layout.js [name]      (default clean_ink; run test_font.js first)
const fs = require("fs");
const path = require("path");
const { loadAll } = require("./load");

const HF = loadAll();
const name = process.argv[2] || "clean_ink";
const lib = JSON.parse(fs.readFileSync(path.join(__dirname, "out", name + ".library.json"), "utf8"));
let bad = 0;
function ok(cond, msg) { if (!cond) { bad++; console.log("  PROBLEM:", msg); } }

const page = HF.layout.PAGES.card;
const base = { pageW: page.w, pageH: page.h, size: HF.layout.defaultSize("card", 5), seed: 7 };
const note = "Dear friend, I wish I could hand you this note in person. Since I can't, I wrote it in my own handwriting instead. Miss you lots.";

// 1) a normal note: wraps, stays inside the margins, has a caret for every position
const a = HF.layout.layoutText(note, lib, base);
console.log(`note: ${a.glyphs.length} glyphs, ${a.lines} lines, size ${a.size.toFixed(1)}pt (asked ${base.size.toFixed(1)}), overflow=${a.overflow}`);
ok(a.caret.length === note.length + 1, "caret list has the wrong length");
ok(a.lines >= 3 && a.lines <= 9, "unexpected number of lines: " + a.lines);
const m = a.margin;
a.glyphs.forEach((g) => {
  const half = g.cx * g.s;
  if (g.x - half < m - 6 || g.x + half > page.w - m + 6) ok(false, `"${g.ch}" at index ${g.index} sticks out of the margin`);
});
ok(a.glyphs.every((g) => g.y > 0 && g.y < page.h), "a glyph is off the page vertically");

// 2) deterministic: same input twice gives the identical result
const b = HF.layout.layoutText(note, lib, base);
ok(JSON.stringify(a.glyphs) === JSON.stringify(b.glyphs), "layout is not deterministic");
const c = HF.layout.layoutText(note, lib, Object.assign({}, base, { seed: 8 }));
ok(JSON.stringify(a.glyphs) !== JSON.stringify(c.glyphs), "a different seed should change the wobble");
const flat = HF.layout.layoutText(note, lib, Object.assign({}, base, { wobble: false }));
ok(flat.glyphs.every((g) => g.rot === 0 && Math.abs(g.s - flat.size / 1000) < 1e-12), "wobble:false should not wobble");
ok(flat.lines === a.lines, "wobble must not change where lines break");

// 3) long text shrinks to fit the page
const long = note.repeat(6);
const d = HF.layout.layoutText(long, lib, base);
console.log(`long: ${d.glyphs.length} glyphs, ${d.lines} lines, size ${d.size.toFixed(1)}pt, overflow=${d.overflow}`);
ok(d.size < base.size, "long text should shrink");
ok(!d.overflow, "long text should still fit");
const lastBase = d.caret[long.length].y;
ok(lastBase <= page.h - d.margin + 0.5, "last line is below the bottom margin");

// 4) absurd amounts of text: reports overflow instead of hanging
const huge = HF.layout.layoutText("word ".repeat(4000), lib, base);
ok(huge.overflow, "huge text should report overflow");

// 5) newlines, blank lines, a single huge word, missing characters
const e = HF.layout.layoutText("Hi\n\nthere", lib, base);
ok(e.lines === 3, "newlines: expected 3 lines, got " + e.lines);
ok(e.caret[3].line === 1 && e.caret[4].line === 2, "caret after newlines is on the wrong line");
const w = HF.layout.layoutText("Supercalifragilisticexpialidocious_Supercalifragilistic", lib, base);
ok(w.lines >= 2, "an over-long word should break across lines");
w.glyphs.forEach((g) => { if (g.x + g.cx * g.s > page.w - w.margin + 6) ok(false, "over-long word sticks out"); });
const mis = HF.layout.layoutText("café ❤ ok", lib, base);
ok(mis.missing.includes("é") && mis.missing.includes("❤"), "missing characters should be reported: " + mis.missing.join(""));
ok(HF.layout.layoutText("", lib, base).glyphs.length === 0, "empty text");
const q = HF.layout.layoutText("“Hi” — ok…", lib, base);
ok(q.missing.length === 0 && q.glyphs.length === 8, "curly quotes, dash and ellipsis should be drawn (got " + q.glyphs.length + " glyphs, missing " + q.missing.join("") + ")");

// 6) clicking: nearest caret index
const mid = a.caret[40];
ok(HF.layout.indexAt(a, mid.x + 1, mid.y - 5) === 40, "indexAt should find a position clicked right next to it");
ok(HF.layout.indexAt(a, 5, a.caret[0].y) === 0, "click before the first letter");

// 7) lines paper
ok(a.ruleYs.length >= a.lines, "ruled lines should cover the text lines");

console.log(bad ? `\n${bad} problem(s)` : "\nlayout looks right");
process.exit(bad ? 1 : 0);
