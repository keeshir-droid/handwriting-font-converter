// Turns one character's pixels into smooth vector outlines.
//
//   HF.tracer.traceGlyph(glyph, f, lsb) -> { adv, contours }
//
// glyph = one entry of reader result.glyphs: a binary mask (mw x mh) cut out of the photo at (ox, oy),
// plus the baseline (image y) and f (font units per pixel). Output contours are in font units
// (1000 per em, y up, baseline at y = 0), TrueType style (see outline.js).
//
// How: blur the mask a little into a smooth "ink amount" field, find the 0.5 level line with marching
// squares (sub-pixel accurate), drop specks, simplify, then turn the polygon into quadratic curves:
// smooth vertices become off-curve control points, sharp turns stay as crisp on-curve corners.
(function () {
  const HF = (globalThis.HF = globalThis.HF || {});

  const PAD = 4;           // empty pixels around the mask so every outline closes
  const DEFAULT_LSB = 45;  // side bearing, font units
  const MIN_LOOP_AREA = 6; // px^2: smaller loops are specks
  const SIMPLIFY_EPS = 0.6; // px
  const CORNER_DEG = 70;   // turns sharper than this stay corners
  const MIN_ADVANCE = 240; // narrow marks (. , ' :) still get some room

  function blur(field, W, H, sigma) {
    const rad = Math.max(1, Math.ceil(sigma * 3));
    const k = new Float32Array(rad * 2 + 1);
    let sum = 0;
    for (let i = -rad; i <= rad; i++) { k[i + rad] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + rad]; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let i = -rad; i <= rad; i++) {
          const xx = x + i;
          if (xx >= 0 && xx < W) s += field[y * W + xx] * k[i + rad];
        }
        tmp[y * W + x] = s;
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let i = -rad; i <= rad; i++) {
          const yy = y + i;
          if (yy >= 0 && yy < H) s += tmp[yy * W + x] * k[i + rad];
        }
        out[y * W + x] = s;
      }
    }
    return out;
  }

  // Marching squares at level 0.5. Field nodes sit at integer positions (i, j); returns closed loops
  // of [x, y] in node coordinates. Segments are directed so that ink is always on the same side, which
  // lets us chain them by edge id: an edge id names the grid edge a segment starts or ends on.
  function marchingSquares(f, W, H) {
    const HW = W * H;
    const next = new Int32Array(2 * HW).fill(-1);
    for (let j = 0; j < H - 1; j++) {
      for (let i = 0; i < W - 1; i++) {
        const vA = f[j * W + i], vB = f[j * W + i + 1], vC = f[(j + 1) * W + i + 1], vD = f[(j + 1) * W + i];
        const code = (vA >= 0.5 ? 8 : 0) | (vB >= 0.5 ? 4 : 0) | (vC >= 0.5 ? 2 : 0) | (vD >= 0.5 ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const T = j * W + i, B = (j + 1) * W + i, L = HW + j * W + i, R = HW + j * W + i + 1;
        switch (code) {
          case 8: next[L] = T; break;
          case 4: next[T] = R; break;
          case 2: next[R] = B; break;
          case 1: next[B] = L; break;
          case 12: next[L] = R; break;
          case 6: next[T] = B; break;
          case 3: next[R] = L; break;
          case 9: next[B] = T; break;
          case 14: next[L] = B; break;
          case 7: next[T] = L; break;
          case 11: next[R] = T; break;
          case 13: next[B] = R; break;
          case 10: // saddle: A and C inside
            if ((vA + vB + vC + vD) / 4 >= 0.5) { next[R] = T; next[L] = B; } else { next[L] = T; next[R] = B; }
            break;
          case 5: // saddle: B and D inside
            if ((vA + vB + vC + vD) / 4 >= 0.5) { next[T] = L; next[B] = R; } else { next[T] = R; next[B] = L; }
            break;
        }
      }
    }
    function pos(id) {
      if (id < HW) {
        const j = (id / W) | 0, i = id - j * W;
        const a = f[id], b = f[id + 1];
        return [i + (0.5 - a) / (b - a), j];
      }
      const id2 = id - HW, j = (id2 / W) | 0, i = id2 - j * W;
      const a = f[id2], b = f[id2 + W];
      return [i, j + (0.5 - a) / (b - a)];
    }
    const used = new Uint8Array(2 * HW);
    const loops = [];
    for (let s = 0; s < 2 * HW; s++) {
      if (next[s] < 0 || used[s]) continue;
      const loop = [];
      let cur = s;
      while (cur >= 0 && !used[cur]) {
        used[cur] = 1;
        loop.push(pos(cur));
        cur = next[cur];
      }
      if (cur === s && loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  function polyArea(p) { // signed, any orientation convention (shoelace)
    let a = 0;
    for (let i = 0, n = p.length; i < n; i++) {
      const u = p[i], v = p[(i + 1) % n];
      a += u[0] * v[1] - v[0] * u[1];
    }
    return a / 2;
  }

  // Douglas-Peucker on the open run arr[from..to] (inclusive), returns the kept points in order.
  function rdp(arr, from, to, eps) {
    const keep = new Uint8Array(arr.length);
    keep[from] = 1; keep[to] = 1;
    const stack = [[from, to]];
    while (stack.length) {
      const seg = stack.pop();
      const a = arr[seg[0]], b = arr[seg[1]];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.sqrt(dx * dx + dy * dy);
      let worst = -1, wd = eps;
      for (let i = seg[0] + 1; i < seg[1]; i++) {
        const p = arr[i];
        const d = len > 1e-9 ? Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len : Math.hypot(p[0] - a[0], p[1] - a[1]);
        if (d > wd) { wd = d; worst = i; }
      }
      if (worst >= 0) { keep[worst] = 1; stack.push([seg[0], worst], [worst, seg[1]]); }
    }
    const out = [];
    for (let i = from; i <= to; i++) if (keep[i]) out.push(arr[i]);
    return out;
  }

  function simplifyClosed(pts, eps) {
    const n = pts.length;
    if (n < 6) return pts;
    let far = 0, fd = -1;
    for (let i = 1; i < n; i++) {
      const d = (pts[i][0] - pts[0][0]) * (pts[i][0] - pts[0][0]) + (pts[i][1] - pts[0][1]) * (pts[i][1] - pts[0][1]);
      if (d > fd) { fd = d; far = i; }
    }
    const arr = pts.concat([pts[0]]);
    const h1 = rdp(arr, 0, far, eps);
    const h2 = rdp(arr, far, n, eps);
    return h1.concat(h2.slice(1, h2.length - 1));
  }

  // polygon (vertices [x,y]) -> TrueType-style points. Gentle vertices are off-curve controls, sharp ones on-curve.
  function toQuadratic(poly) {
    const n = poly.length;
    const out = [];
    const cosLimit = Math.cos((CORNER_DEG * Math.PI) / 180);
    for (let i = 0; i < n; i++) {
      const p = poly[i], a = poly[(i + n - 1) % n], b = poly[(i + 1) % n];
      const ux = p[0] - a[0], uy = p[1] - a[1], vx = b[0] - p[0], vy = b[1] - p[1];
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      let corner = false;
      if (lu > 1e-9 && lv > 1e-9) corner = (ux * vx + uy * vy) / (lu * lv) < cosLimit; // angle between directions
      out.push({ x: p[0], y: p[1], on: corner });
    }
    return out;
  }

  function pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // TrueType wants outer contours clockwise and holes counter-clockwise (y up).
  function fixOrientation(contours) {
    return contours.map(function (c, i) {
      let depth = 0;
      for (let j = 0; j < contours.length; j++) {
        if (j !== i && pointInPoly(c[0].x, c[0].y, contours[j])) depth++;
      }
      const ccw = HF.outline.area(c) > 0;
      const wantCcw = depth % 2 === 1;
      return ccw === wantCcw ? c : c.slice().reverse();
    });
  }

  function traceGlyph(glyph, f, lsb) {
    lsb = lsb == null ? DEFAULT_LSB : lsb;
    const W = glyph.mw + PAD * 2, H = glyph.mh + PAD * 2;
    const field = new Float32Array(W * H);
    for (let y = 0; y < glyph.mh; y++) {
      for (let x = 0; x < glyph.mw; x++) {
        if (glyph.mask[y * glyph.mw + x]) field[(y + PAD) * W + x + PAD] = 1;
      }
    }
    const smooth = blur(field, W, H, 1.0);
    const loops = marchingSquares(smooth, W, H);

    // node (i, j) is the centre of padded pixel (i, j) -> image pixel coordinates
    const px0 = glyph.ox - PAD + 0.5, py0 = glyph.oy - PAD + 0.5;
    const polys = [];
    loops.forEach(function (loop) {
      if (Math.abs(polyArea(loop)) < MIN_LOOP_AREA) return;
      const s = simplifyClosed(loop, SIMPLIFY_EPS);
      if (s.length < 3 || Math.abs(polyArea(s)) < MIN_LOOP_AREA) return;
      polys.push(s.map(function (p) { return [p[0] + px0, p[1] + py0]; }));
    });
    if (!polys.length) return { adv: MIN_ADVANCE, contours: [] };

    let left = Infinity, right = -Infinity;
    polys.forEach(function (p) { p.forEach(function (q) { if (q[0] < left) left = q[0]; if (q[0] > right) right = q[0]; }); });
    const widthUnits = (right - left) * f;
    const adv = Math.max(widthUnits + 2 * lsb, MIN_ADVANCE);
    const centring = (adv - (widthUnits + 2 * lsb)) / 2;

    let contours = polys.map(function (p) {
      return toQuadratic(p).map(function (q) {
        return { x: (q.x - left) * f + lsb + centring, y: (glyph.baseline - q.y) * f, on: q.on };
      });
    });
    contours = fixOrientation(contours);
    return { adv: adv, contours: contours };
  }

  HF.tracer = { traceGlyph: traceGlyph, _internals: { blur: blur, marchingSquares: marchingSquares, simplifyClosed: simplifyClosed, toQuadratic: toQuadratic } };
})();
