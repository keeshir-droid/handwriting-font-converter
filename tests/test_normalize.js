// Developer-only. Checks the alphabet-wide tidy-ups (word space, descender height, punctuation placement).
//   node tests/test_normalize.js [name]      (default rishi_big; run `node tests/test_font.js <name>` first)
const fs = require("fs");
const path = require("path");
const { loadAll } = require("./load");

const HF = loadAll();
const name = process.argv[2] || "rishi_big";
const file = path.join(__dirname, "out", name + ".library.json");
if (!fs.existsSync(file)) { console.log("run: node tests/test_font.js " + name); process.exit(1); }
const lib = JSON.parse(fs.readFileSync(file, "utf8"));
let bad = 0;
function ok(cond, msg) { if (!cond) { bad++; console.log("  PROBLEM:", msg); } }
const B = (ch) => HF.outline.bounds(lib.glyphs[ch].contours);

// 1) running it again changes nothing
const once = JSON.stringify(HF.library.normalize(JSON.parse(JSON.stringify(lib))));
ok(once === JSON.stringify(lib), "normalize is not idempotent");

// 2) word space is clearly wider than the gap between letters
const letterGap = 2 * HF.library.LSB;
ok(lib.glyphs[" "].adv >= 380, "word space too small: " + lib.glyphs[" "].adv);
ok(lib.glyphs[" "].adv + letterGap >= 4 * letterGap, "word gap should be at least 4x the letter gap");

// 3) the body of g p q y reaches (about) the x-height of the other lowercase letters
const tops = "acemnorsuvwxz".split("").map((c) => B(c).y1).sort((a, b) => a - b);
const xh = tops[tops.length >> 1];
"gpqy".split("").forEach((c) => ok(B(c).y1 >= xh - 60, `${c} sits too low (top ${B(c).y1.toFixed(0)}, x-height ${xh.toFixed(0)})`));

// 4) punctuation in a believable band around the line
["!", "?"].forEach((c) => { ok(Math.abs(B(c).y0) < 15, `${c} should rest on the line`); ok(B(c).y1 <= 705, `${c} too tall`); });
ok(B("(").y0 > -260 && B(")").y0 > -260, "parentheses hang too low");
ok(B("-").y0 > 20, "hyphen sits on the baseline");
ok(B(";").y1 <= xh + 40 && B(";").y1 >= xh - 40, "semicolon dot should sit at x-height");

console.log(`${name}: word space ${lib.glyphs[" "].adv}, x-height ${xh.toFixed(0)}`);
console.log(bad ? `\n${bad} problem(s)` : "\ntidy-ups look right");
process.exit(bad ? 1 : 0);
