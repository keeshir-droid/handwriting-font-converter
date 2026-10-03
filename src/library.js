// Builds the full character library from what the reader found.
//
//   HF.library.build(readerResult) -> { glyphs, aliases }
//
// glyphs  = { ch: { adv, contours } }   the 72 written characters, the comma, and a few made from them
//                                       (space, double quote, en/em dash, ellipsis)
// aliases = { ch: otherCh }              characters that just reuse another one (curly quotes, non-breaking space)
//
// Everything is in font units (1000 per em, y up, baseline at 0). Library is plain data: it can be saved as JSON.
(function () {
  const HF = (globalThis.HF = globalThis.HF || {});

  const LSB = 45;
  const SPACE_ADV = 300;

  function widthOf(g) { const b = HF.outline.bounds(g.contours); return b ? b.x1 - b.x0 : 0; }

  function copyContours(contours) { return contours.map(function (c) { return c.map(function (p) { return { x: p.x, y: p.y, on: p.on }; }); }); }

  // several copies of a glyph side by side (" from ', … from .)
  function repeated(g, times, gap) {
    const w = widthOf(g);
    let out = [];
    for (let i = 0; i < times; i++) out = out.concat(HF.outline.shiftScale(copyContours(g.contours), i * (w + gap), 0, 1, 1));
    return { adv: times * w + (times - 1) * gap + 2 * LSB, contours: out };
  }

  // stretch sideways, keeping the left edge (hyphen -> en dash / em dash)
  function stretched(g, k) {
    return {
      adv: (g.adv - 2 * LSB) * k + 2 * LSB,
      contours: HF.outline.shiftScale(copyContours(g.contours), LSB * (1 - k), 0, k, 1),
    };
  }

  function build(result) {
    const glyphs = {};
    Object.keys(result.glyphs).forEach(function (ch) {
      const g = result.glyphs[ch];
      glyphs[ch] = HF.tracer.traceGlyph(g, g.f, LSB);
    });
    if (result.comma) glyphs[","] = HF.tracer.traceGlyph(result.comma, result.comma.f, LSB);

    glyphs[" "] = { adv: SPACE_ADV, contours: [] };
    if (glyphs["'"] && glyphs["'"].contours.length) glyphs['"'] = repeated(glyphs["'"], 2, 70);
    if (glyphs["-"] && glyphs["-"].contours.length) {
      glyphs["–"] = stretched(glyphs["-"], 1.6);
      glyphs["—"] = stretched(glyphs["-"], 2.4);
    }
    if (glyphs["."] && glyphs["."].contours.length) glyphs["…"] = repeated(glyphs["."], 3, 90);

    const aliases = { " ": " ", "‘": "'", "’": "'", "“": '"', "”": '"' };
    return { glyphs: glyphs, aliases: aliases };
  }

  // what a typed character should be drawn as (curly quotes, nbsp ...), or null when the font has nothing for it
  function resolve(lib, ch) {
    if (lib.glyphs[ch]) return ch;
    const a = lib.aliases[ch];
    return a && lib.glyphs[a] ? a : null;
  }

  HF.library = { build: build, resolve: resolve, LSB: LSB };
})();
