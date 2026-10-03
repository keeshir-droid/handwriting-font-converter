// Shared helpers for glyph outlines.
//
// An outline is a list of contours. A contour is a list of points {x, y, on} in font units
// (1000 per em, y pointing up), TrueType style: "on" points are on the curve, "off" points are
// control points of a quadratic curve. Two off points in a row imply an on point halfway between.
(function () {
  const HF = (globalThis.HF = globalThis.HF || {});

  // Rewrite a contour so it starts with an on point and has an explicit on point between every
  // pair of off points. Output is what the font file and the PDF need.
  function explicit(contour) {
    const n = contour.length;
    if (n === 0) return [];
    const pts = [];
    for (let i = 0; i < n; i++) {
      const p = contour[i];
      const q = contour[(i + 1) % n];
      pts.push({ x: p.x, y: p.y, on: p.on });
      if (!p.on && !q.on) pts.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, on: true });
    }
    // rotate so the first point is on-curve
    let first = -1;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].on) { first = i; break; }
    }
    if (first < 0) return pts; // cannot happen after the loop above, kept for safety
    return pts.slice(first).concat(pts.slice(0, first));
  }

  // Walk a contour and call moveTo / lineTo / quadTo. Works on any contour.
  function walk(contour, moveTo, lineTo, quadTo) {
    const pts = explicit(contour);
    const n = pts.length;
    if (n < 2) return;
    moveTo(pts[0].x, pts[0].y);
    let i = 1;
    while (i <= n) {
      const p = pts[i % n];
      if (p.on) {
        lineTo(p.x, p.y);
        i += 1;
      } else {
        const e = pts[(i + 1) % n];
        quadTo(p.x, p.y, e.x, e.y);
        i += 2;
      }
    }
  }

  function bounds(contours) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of contours) {
      for (const p of c) {
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.y > y1) y1 = p.y;
      }
    }
    if (x0 === Infinity) return null;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  function transform(contours, fn) {
    return contours.map(function (c) {
      return c.map(function (p) {
        const q = fn(p.x, p.y);
        return { x: q[0], y: q[1], on: p.on };
      });
    });
  }

  function shiftScale(contours, dx, dy, sx, sy) {
    return transform(contours, function (x, y) { return [x * sx + dx, y * sy + dy]; });
  }

  // Signed area in y-up coordinates: positive = counter-clockwise.
  function area(poly) {
    let a = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const p = poly[i], q = poly[(i + 1) % n];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  HF.outline = { explicit: explicit, walk: walk, bounds: bounds, transform: transform, shiftScale: shiftScale, area: area };
})();
