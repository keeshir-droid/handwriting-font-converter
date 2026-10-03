// Puts typed text on a page in the user's handwriting.
//
//   HF.layout.layoutText(text, lib, opts) -> { glyphs, caret, ruleYs, size, lines, overflow, missing }
//
//   lib   = HF.library.build(...) result ({ glyphs, aliases })
//   opts  = { pageW, pageH (pt), margin (pt), size (pt per em, the size you would LIKE),
//             lineHeight (em, default 1.3), wobble (bool, default true), seed (int) }
//
//   glyphs[i] = { ch, index, x, y, s, rot, cx }
//     draw with:  translate(x, y)  rotate(rot)  scale(s, -s)  translate(-cx, 0)
//     x = horizontal middle of the letter on the page (pt), y = its baseline (pt, y points DOWN),
//     s = pt per font unit, rot = radians, cx = half the advance in font units.
//   caret[i]  = { x, y, line } where the caret sits before text[i] (caret[text.length] = at the end); y = baseline
//   ruleYs    = y of each ruled line (for the optional "lines" paper), independent of the text
//
// The wobble (a little rotation, height, size and sideways jitter per letter) is deterministic: the same text,
// seed and page always give the same result, so the preview, the PNG and the PDF match exactly. It only
// affects drawing. The installed .ttf cannot wobble.
(function () {
  const HF = (globalThis.HF = globalThis.HF || {});

  // page sizes in points (1 pt = 1/72 inch); base = default text size as a fraction of page width
  const PAGES = {
    card: { label: "Card", w: 360, h: 504, base: 0.085 },     // 5 x 7 in
    a4: { label: "A4", w: 595, h: 842, base: 0.055 },
    letter: { label: "Letter", w: 612, h: 792, base: 0.055 },
    square: { label: "Square", w: 540, h: 540, base: 0.07 },
  };

  // text-size slider 1..10 (5 = normal) -> multiplier
  function sizeFactor(slider) {
    const s = Math.max(1, Math.min(10, slider));
    return s <= 5 ? 0.6 + (s - 1) * 0.1 : 1 + (s - 5) * 0.09;
  }

  function defaultSize(pageKey, slider) {
    const p = PAGES[pageKey] || PAGES.card;
    return p.w * p.base * sizeFactor(slider);
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // lay the characters out in lines at one text size (no wobble)
  function flow(text, lib, size, width, lh) {
    const k = size / 1000;
    const adv = function (ch) {
      const r = HF.library.resolve(lib, ch);
      return r ? lib.glyphs[r].adv * k : 0;
    };
    const spaceAdv = lib.glyphs[" "] ? lib.glyphs[" "].adv * k : size * 0.3;
    const pos = []; // per character: { x (left edge), line, w, shown }
    let x = 0, line = 0;
    const n = text.length;
    let i = 0;
    while (i < n) {
      const ch = text[i];
      if (ch === "\n") { pos[i] = { x: x, line: line, w: 0, shown: false }; line++; x = 0; i++; continue; }
      if (ch === "\r") { pos[i] = { x: x, line: line, w: 0, shown: false }; i++; continue; }
      if (ch === " " || ch === "\t" || ch === " ") {
        const w = ch === "\t" ? spaceAdv * 4 : (adv(ch) || spaceAdv);
        pos[i] = { x: x, line: line, w: w, shown: false }; // spaces may hang past the edge: they never force a wrap
        x += w; i++; continue;
      }
      // a word: everything up to the next space / newline
      let j = i, wordW = 0;
      while (j < n && text[j] !== " " && text[j] !== "\n" && text[j] !== "\r" && text[j] !== "\t" && text[j] !== " ") { wordW += adv(text[j]); j++; }
      if (x > 0 && x + wordW > width && wordW <= width) { line++; x = 0; } // wrap before the word
      for (let c = i; c < j; c++) { // (a word wider than a whole line is broken between characters)
        const w = adv(text[c]);
        if (x > 0 && x + w > width) { line++; x = 0; }
        pos[c] = { x: x, line: line, w: w, shown: w > 0 };
        x += w;
      }
      i = j;
    }
    return { pos: pos, lines: line + 1, endX: x, endLine: line };
  }

  function layoutText(text, lib, opts) {
    text = String(text == null ? "" : text);
    const pageW = opts.pageW, pageH = opts.pageH;
    const margin = opts.margin != null ? opts.margin : pageW * 0.1;
    const lh = opts.lineHeight || 1.3;
    const width = pageW - 2 * margin, height = pageH - 2 * margin;
    const wanted = opts.size;
    const top = 0.9; // baseline of the first line, in em below the top margin

    // biggest size (<= wanted) at which everything fits on the page
    function fits(size) {
      const f = flow(text, lib, size, width, lh);
      return top * size + (f.lines - 1) * lh * size + 0.3 * size <= height;
    }
    let size = wanted;
    let overflow = false;
    if (!fits(size)) {
      let lo = wanted * 0.2, hi = wanted;
      if (!fits(lo)) { size = lo; overflow = true; }
      else {
        for (let it = 0; it < 14; it++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
        size = lo;
      }
    }

    const f = flow(text, lib, size, width, lh);
    const k = size / 1000;
    const baselineOf = function (line) { return margin + (top + line * lh) * size; };
    const wobble = opts.wobble !== false;
    const seed = opts.seed == null ? 1 : opts.seed;

    const glyphs = [], caret = [];
    for (let i = 0; i < text.length; i++) {
      const p = f.pos[i];
      const baseY = baselineOf(p.line);
      caret[i] = { x: margin + p.x, y: baseY, line: p.line };
      const r = HF.library.resolve(lib, text[i]);
      if (!p.shown || !r) continue;
      const g = lib.glyphs[r];
      if (!g.contours.length) continue;
      let rot = 0, dy = 0, sc = 1, dx = 0;
      if (wobble) {
        const rnd = mulberry32((seed * 7919 + (i + 1) * 2654435761) | 0);
        rot = ((rnd() * 2 - 1) * 1.6 * Math.PI) / 180;
        dy = (rnd() * 2 - 1) * 0.014 * size;
        sc = 1 + (rnd() * 2 - 1) * 0.03;
        dx = (rnd() * 2 - 1) * 0.006 * size;
      }
      glyphs.push({ ch: r, index: i, x: margin + p.x + (g.adv * k) / 2 + dx, y: baseY + dy, s: k * sc, rot: rot, cx: g.adv / 2 });
    }
    const endLine = f.endLine;
    caret[text.length] = { x: margin + f.endX, y: baselineOf(endLine), line: endLine };

    const ruleYs = [];
    for (let y = baselineOf(0) + 0.16 * size; y <= pageH - margin + 0.001; y += lh * size) ruleYs.push(y);

    const missing = [];
    const seen = {};
    Array.from(text).forEach(function (ch) {
      if (/\s/.test(ch) || seen[ch]) return;
      seen[ch] = 1;
      if (!HF.library.resolve(lib, ch)) missing.push(ch);
    });

    return { glyphs: glyphs, caret: caret, ruleYs: ruleYs, size: size, lines: f.lines, overflow: overflow, missing: missing, margin: margin };
  }

  // Which text index is nearest to a point on the page (for clicking on the paper).
  function indexAt(layout, x, y) {
    const c = layout.caret;
    let best = 0, bd = Infinity;
    // first find the closest line, then the closest position on it
    let bestLineY = Infinity;
    for (let i = 0; i < c.length; i++) { const dy = Math.abs(c[i].y - y); if (dy < bestLineY) bestLineY = dy; }
    for (let i = 0; i < c.length; i++) {
      const dy = Math.abs(c[i].y - y);
      if (dy > bestLineY + 0.5) continue;
      const dx = Math.abs(c[i].x - x);
      if (dx < bd) { bd = dx; best = i; }
    }
    return best;
  }

  HF.layout = { PAGES: PAGES, sizeFactor: sizeFactor, defaultSize: defaultSize, layoutText: layoutText, indexAt: indexAt };
})();
