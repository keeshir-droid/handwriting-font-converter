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

  function median(a) {
    const b = a.slice().sort(function (x, y) { return x - y; });
    return b.length ? b[b.length >> 1] : 0;
  }

  // Scale a mark down if it is taller than maxH, then slide it so its bottom / top / middle is at the target height.
  function fitGlyph(gl, o) {
    if (!gl || !gl.contours.length) return;
    let b = HF.outline.bounds(gl.contours);
    if (o.maxH && b.y1 - b.y0 > o.maxH + 5) {
      const k = o.maxH / (b.y1 - b.y0);
      gl.contours = HF.outline.shiftScale(gl.contours, LSB * (1 - k), 0, k, k);
      gl.adv = (gl.adv - 2 * LSB) * k + 2 * LSB;
      b = HF.outline.bounds(gl.contours);
    }
    let dy = 0;
    if (o.bottom != null) dy = o.bottom - b.y0;
    else if (o.top != null) dy = o.top - b.y1;
    else if (o.centre != null) dy = o.centre - (b.y0 + b.y1) / 2;
    if (Math.abs(dy) > 8) gl.contours = HF.outline.shiftScale(gl.contours, 0, dy, 1, 1);
  }

  // Tidy-ups that depend on the whole alphabet. Safe to run again on an already tidied library (and it is run on
  // saved libraries when they are loaded, so improvements reach handwriting made earlier).
  //  1) Word space: sized from this writer's own letter widths. Round handwritten letters need a wide gap before
  //     a gap between words reads as a gap at all.
  //  2) The body of g, p, q and y sits on the same x-height band as the other lowercase letters. When a descender
  //     letter was written lower than its neighbours, its head floated below the line of the word. Only lifts.
  function normalize(lib) {
    const g = lib.glyphs;
    const widths = "abcdefghijklmnopqrstuvwxyz".split("").filter(function (c) { return g[c] && g[c].contours.length; }).map(function (c) { return g[c].adv; });
    if (widths.length >= 10 && g[" "]) g[" "].adv = Math.max(380, Math.min(700, Math.round(1.05 * median(widths))));

    // keep marks that were written unusually tall or low inside a sensible band around the line
    const xh0 = (function () {
      const ts = "acemnorsuvwxz".split("").filter(function (c) { return g[c] && g[c].contours.length; }).map(function (c) { return HF.outline.bounds(g[c].contours).y1; });
      return ts.length >= 6 ? median(ts) : 315;
    })();
    fitGlyph(g["!"], { maxH: 700, bottom: 0 });
    fitGlyph(g["?"], { maxH: 700, bottom: 0 });
    fitGlyph(g[":"], { maxH: 420, bottom: 0 });
    fitGlyph(g[";"], { maxH: 560, top: xh0 });
    fitGlyph(g["("], { maxH: 820, bottom: -190 });
    fitGlyph(g[")"], { maxH: 820, bottom: -190 });
    fitGlyph(g["-"], { centre: Math.round(0.45 * xh0) });
    fitGlyph(g[","], { top: 170 });
    // characters made from others follow their source
    if (g["'"] && g["'"].contours.length) g['"'] = repeated(g["'"], 2, 70);
    if (g["-"] && g["-"].contours.length) { g["\u2013"] = stretched(g["-"], 1.6); g["\u2014"] = stretched(g["-"], 2.4); }
    if (g["."] && g["."].contours.length) g["\u2026"] = repeated(g["."], 3, 90);

    const tops = "acemnorsuvwxz".split("").filter(function (c) { return g[c] && g[c].contours.length; }).map(function (c) { return HF.outline.bounds(g[c].contours).y1; });
    if (tops.length >= 6) {
      const xh = median(tops);
      "gpqy".split("").forEach(function (c) {
        if (!g[c] || !g[c].contours.length) return;
        const b = HF.outline.bounds(g[c].contours);
        const lift = xh - b.y1;
        if (lift > 40) g[c].contours = HF.outline.shiftScale(g[c].contours, 0, Math.min(lift, 400), 1, 1);
      });
    }
    return lib;
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
    return normalize({ glyphs: glyphs, aliases: aliases });
  }

  // what a typed character should be drawn as (curly quotes, nbsp ...), or null when the font has nothing for it
  function resolve(lib, ch) {
    if (lib.glyphs[ch]) return ch;
    const a = lib.aliases[ch];
    return a && lib.glyphs[a] ? a : null;
  }

  HF.library = { build: build, normalize: normalize, resolve: resolve, LSB: LSB };
})();
