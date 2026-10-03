// Reads a photo of the handwriting sheet.
//
//   HF.reader.read({width, height, data /* RGBA */}) -> result
//
// Pure JavaScript on plain arrays (no browser features), so the same code runs in the page and
// in the node tests. Steps are explained in plain English in handwriting-font.md.
(function () {
  const HF = (globalThis.HF = globalThis.HF || {});
  const CS = function () { return HF.charset; };

  // ---------- small helpers ----------

  function median(arr) {
    if (!arr.length) return 0;
    const a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
  }

  function toGray(img) {
    const n = img.width * img.height;
    const g = new Uint8Array(n);
    const d = img.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      g[i] = (d[j] * 77 + d[j + 1] * 151 + d[j + 2] * 28) >> 8;
    }
    return g;
  }

  // Marks pixels that are clearly darker than their surroundings (= ink).
  // Using the local average (not one global brightness) is what makes shadows mostly harmless.
  function inkMask(gray, w, h) {
    const r = Math.max(14, Math.round(Math.max(w, h) / 70));
    const W1 = w + 1;
    const integral = new Uint32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += gray[y * w + x];
        integral[(y + 1) * W1 + (x + 1)] = integral[y * W1 + (x + 1)] + row;
      }
    }
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const sum = integral[y1 * W1 + x1] - integral[y0 * W1 + x1] - integral[y1 * W1 + x0] + integral[y0 * W1 + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        const v = gray[y * w + x];
        if (v < mean - Math.max(22, mean * 0.16)) mask[y * w + x] = 1;
      }
    }
    return mask;
  }

  // ---------- finding the page ----------

  // If the photo shows a table around the paper, find the paper (the big bright area) so that
  // table texture is never mistaken for ink. Returns null when the page fills the picture.
  function paperRegion(gray, w, h) {
    const f = 8;
    const lw = Math.floor(w / f), lh = Math.floor(h / f);
    if (lw < 20 || lh < 20) return null;
    let cur = new Float32Array(lw * lh);
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        let s = 0;
        for (let dy = 0; dy < f; dy += 2) for (let dx = 0; dx < f; dx += 2) s += gray[(y * f + dy) * w + x * f + dx];
        cur[y * lw + x] = s / ((f / 2) * (f / 2));
      }
    }
    for (let pass = 0; pass < 3; pass++) { // blur so that ink on the page doesn't punch holes in it
      const nxt = new Float32Array(lw * lh);
      for (let y = 0; y < lh; y++) {
        for (let x = 0; x < lw; x++) {
          let s = 0, c = 0;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const yy = y + dy, xx = x + dx;
              if (yy < 0 || yy >= lh || xx < 0 || xx >= lw) continue;
              s += cur[yy * lw + xx]; c++;
            }
          }
          nxt[y * lw + x] = s / c;
        }
      }
      cur = nxt;
    }
    // Otsu threshold
    const hist = new Float64Array(256);
    for (let i = 0; i < cur.length; i++) hist[Math.min(255, Math.max(0, cur[i] | 0))]++;
    let total = cur.length, sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let wB = 0, sumB = 0, best = -1, thr = 128, gap = 0;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sumAll - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; gap = mF - mB; }
    }
    // only treat it as "paper on a table" if the two areas are clearly different in brightness
    if (gap < 45) return null;
    const bright = new Uint8Array(lw * lh);
    for (let i = 0; i < bright.length; i++) bright[i] = cur[i] > thr ? 1 : 0;
    // a real table surrounds the page: most of the photo's border must be the darker area
    let borderBright = 0, borderTotal = 0;
    for (let x = 0; x < lw; x++) { borderBright += bright[x] + bright[(lh - 1) * lw + x]; borderTotal += 2; }
    for (let y = 1; y < lh - 1; y++) { borderBright += bright[y * lw] + bright[y * lw + lw - 1]; borderTotal += 2; }
    if (borderBright / borderTotal > 0.5) return null;
    // biggest bright area
    const seen = new Uint8Array(lw * lh), stack = new Int32Array(lw * lh);
    let bestList = null;
    for (let s0 = 0; s0 < bright.length; s0++) {
      if (!bright[s0] || seen[s0]) continue;
      const list = [];
      let sp = 0;
      stack[sp++] = s0; seen[s0] = 1;
      while (sp) {
        const p = stack[--sp];
        list.push(p);
        const py = (p / lw) | 0, px = p - py * lw;
        if (px > 0 && bright[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (px < lw - 1 && bright[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (py > 0 && bright[p - lw] && !seen[p - lw]) { seen[p - lw] = 1; stack[sp++] = p - lw; }
        if (py < lh - 1 && bright[p + lw] && !seen[p + lw]) { seen[p + lw] = 1; stack[sp++] = p + lw; }
      }
      if (!bestList || list.length > bestList.length) bestList = list;
    }
    if (!bestList) return null;
    const frac = bestList.length / (lw * lh);
    if (frac < 0.25 || frac > 0.96) return null;
    let page = new Uint8Array(lw * lh);
    bestList.forEach(function (p) { page[p] = 1; });
    // dense writing can look darker than the table once blurred, leaving "holes" in the page.
    // Anything the outside cannot reach is still paper: fill those holes in.
    const outside = new Uint8Array(lw * lh);
    let osp = 0;
    function pushOutside(p) { if (!page[p] && !outside[p]) { outside[p] = 1; stack[osp++] = p; } }
    for (let x = 0; x < lw; x++) { pushOutside(x); pushOutside((lh - 1) * lw + x); }
    for (let y = 0; y < lh; y++) { pushOutside(y * lw); pushOutside(y * lw + lw - 1); }
    while (osp) {
      const p = stack[--osp];
      const py = (p / lw) | 0, px = p - py * lw;
      if (px > 0) pushOutside(p - 1);
      if (px < lw - 1) pushOutside(p + 1);
      if (py > 0) pushOutside(p - lw);
      if (py < lh - 1) pushOutside(p + lw);
    }
    for (let i = 0; i < page.length; i++) page[i] = outside[i] ? 0 : 1;
    // shrink a little so the paper's edge and shadow line are left out
    for (let pass = 0; pass < 3; pass++) {
      const nxt = new Uint8Array(lw * lh);
      for (let y = 1; y < lh - 1; y++) {
        for (let x = 1; x < lw - 1; x++) {
          const i = y * lw + x;
          if (page[i] && page[i - 1] && page[i + 1] && page[i - lw] && page[i + lw]) nxt[i] = 1;
        }
      }
      page = nxt;
    }
    return { page: page, lw: lw, lh: lh, f: f };
  }

  function restrictToPage(mask, w, h, region) {
    if (!region) return;
    const f = region.f;
    for (let y = 0; y < h; y++) {
      const ly = Math.min(region.lh - 1, (y / f) | 0);
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] && !region.page[ly * region.lw + Math.min(region.lw - 1, (x / f) | 0)]) mask[y * w + x] = 0;
      }
    }
  }

  // ---------- tilt ----------

  // Tries small rotations and keeps the one where the lines of writing are the most "stacked".
  function findTilt(mask, w, h) {
    const px = [], py = [];
    const stride = 2;
    for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        if (mask[y * w + x]) { px.push(x); py.push(y); }
      }
    }
    if (px.length < 50) return 0;
    const binSize = Math.max(3, Math.max(w, h) / 600);
    const diag = Math.ceil(Math.sqrt(w * w + h * h) / binSize) + 4;
    function score(deg) {
      const t = (deg * Math.PI) / 180;
      const c = Math.cos(t), s = Math.sin(t);
      const bins = new Float32Array(diag * 2);
      for (let i = 0; i < px.length; i++) {
        const v = py[i] * c - px[i] * s;
        bins[((v / binSize) | 0) + diag]++;
      }
      let sum = 0;
      for (let i = 0; i < bins.length; i++) sum += bins[i] * bins[i];
      return sum;
    }
    let best = 0, bestScore = -1;
    for (let a = -12; a <= 12; a += 0.5) {
      const sc = score(a);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    const center = best;
    for (let a = center - 0.5; a <= center + 0.5; a += 0.1) {
      const sc = score(a);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    return best;
  }

  function rotateGray(gray, w, h, deg, fill) {
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t), s = Math.sin(t);
    // forward map: x' = x c + y s ; y' = -x s + y c
    const xs = [0, w, 0, w].map(function (x, i) { const y = i < 2 ? 0 : h; return x * c + y * s; });
    const ys = [0, w, 0, w].map(function (x, i) { const y = i < 2 ? 0 : h; return -x * s + y * c; });
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    const nw = Math.ceil(maxX - minX), nh = Math.ceil(maxY - minY);
    const out = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const X = x + minX, Y = y + minY;
        const sx = X * c - Y * s, sy = X * s + Y * c;
        if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) { out[y * nw + x] = fill; continue; }
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const i = y0 * w + x0;
        const v = gray[i] * (1 - fx) * (1 - fy) + gray[i + 1] * fx * (1 - fy) + gray[i + w] * (1 - fx) * fy + gray[i + w + 1] * fx * fy;
        out[y * nw + x] = v;
      }
    }
    return { gray: out, w: nw, h: nh };
  }

  // ---------- blobs ----------

  function labelBlobs(mask, w, h) {
    const labels = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    const comps = [];
    let id = 0;
    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || labels[start]) continue;
      id++;
      let sp = 0;
      stack[sp++] = start;
      labels[start] = id;
      let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
      while (sp > 0) {
        const p = stack[--sp];
        const py = (p / w) | 0, px = p - py * w;
        area++;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            if (nx < 0 || nx >= w || (dx === 0 && dy === 0)) continue;
            const q = ny * w + nx;
            if (mask[q] && !labels[q]) { labels[q] = id; stack[sp++] = q; }
          }
        }
      }
      comps.push({ id: id, x0: x0, y0: y0, x1: x1, y1: y1, area: area });
    }
    return { labels: labels, comps: comps };
  }

  // Joins pieces that belong to one character: the dot of an "i", the dot of "?", split letters.
  function mergeIntoGroups(comps, hRef, proto) {
    const parent = comps.map(function (_, i) { return i; });
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }
    const order = comps.map(function (_, i) { return i; }).sort(function (a, b) { return comps[a].x0 - comps[b].x0; });
    // Pieces stacked on top of each other (a dot above a stem) may be a little off to the side.
    // Pieces side by side (a comma next to a letter) must really overlap, or they are separate.
    // Stacked pieces join when their centres line up (a dot over a stem), not merely when they are near.
    const tolSide = 0.005 * hRef, maxStackGap = 0.38 * hRef, centreTol = 0.2 * hRef;
    // a comma tucked under the corner of a letter is NOT part of that letter (a dot over a stem is)
    const isComma = function (c) { return !!proto && commaDist({ w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1, area: c.area }, proto) < 0.9; };
    const isBig = function (c) { return (c.y1 - c.y0 + 1) >= 0.55 * hRef; };
    for (let ai = 0; ai < order.length; ai++) {
      const a = comps[order[ai]];
      for (let bi = ai + 1; bi < order.length; bi++) {
        const b = comps[order[bi]];
        if (b.x0 - centreTol > a.x1) break; // sorted by left edge: nothing further right can match
        if ((isComma(a) && isBig(b)) || (isComma(b) && isBig(a))) continue;
        const gapY = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) - 1;
        const overlapX = !(a.x0 - tolSide > b.x1 || b.x0 - tolSide > a.x1);
        let join = false;
        if (gapY > 0) {
          const dcx = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2);
          const bothSmall = (a.y1 - a.y0 + 1) < 0.55 * hRef && (b.y1 - b.y0 + 1) < 0.55 * hRef;
          // a dot over a tall stem (i, j, !, ?) always belongs together. Two small marks stacked (": ; '" and a
          // comma under an apostrophe) may or may not: that is decided later, by what the list expects there.
          join = !bothSmall && gapY <= maxStackGap && (overlapX || dcx <= centreTol);
        } else {
          join = overlapX;
        }
        if (join) union(order[ai], order[bi]);
      }
    }
    const byRoot = new Map();
    for (let i = 0; i < comps.length; i++) {
      const r = find(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(comps[i]);
    }
    const groups = [];
    byRoot.forEach(function (list) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, area = 0;
      list.forEach(function (c) {
        x0 = Math.min(x0, c.x0); y0 = Math.min(y0, c.y0);
        x1 = Math.max(x1, c.x1); y1 = Math.max(y1, c.y1);
        area += c.area;
      });
      groups.push({ comps: list, x0: x0, y0: y0, x1: x1, y1: y1, area: area,
        w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    });
    return groups;
  }

  // Keep only marks that belong to the block of writing. Dust, table edges and shadows far from the writing are
  // dropped before anything is counted, so they can never be mistaken for a character.
  function keepTextRegion(groups, hRef) {
    const core = groups.filter(function (g) { return g.h >= 0.5 * hRef; });
    const dense = core.filter(function (c) {
      let n = 0;
      for (let i = 0; i < core.length; i++) {
        const o = core[i];
        if (o !== c && Math.abs(o.cx - c.cx) <= 4 * hRef && Math.abs(o.cy - c.cy) <= 4 * hRef) n++;
      }
      return n >= 2;
    });
    if (dense.length < 10) return groups; // cannot tell where the writing is: keep everything
    const near = function (g, o, r) { return Math.abs(g.cx - o.cx) <= r * hRef && Math.abs(g.cy - o.cy) <= r * hRef; };
    const kept = [], rest = [];
    groups.forEach(function (g) {
      let ok = false;
      for (let i = 0; i < dense.length && !ok; i++) ok = near(g, dense[i], 2.5);
      (ok ? kept : rest).push(g);
    });
    // The writing region grows outward: a line that starts with a run of tiny marks (' - : ;) has no big letter
    // beside it, but it sits right next to marks that belong to the writing. Dust far from everything stays out.
    for (let pass = 0; pass < 4 && rest.length; pass++) {
      let added = 0;
      for (let i = rest.length - 1; i >= 0; i--) {
        let ok = false;
        for (let j = 0; j < kept.length && !ok; j++) ok = near(rest[i], kept[j], 2.2);
        if (ok) { kept.push(rest[i]); rest.splice(i, 1); added++; }
      }
      if (!added) break;
    }
    return kept;
  }

  // Lines of writing: join every mark to its nearest neighbour to the right that is at about the same height
  // (allowing the line to slope or wave), and call each connected chain a row. Rows are returned top to bottom,
  // each left to right. This copes with sloping lines and with commas that hang below the line.
  function chainIntoRows(groups, hRef) {
    const n = groups.length;
    const parent = groups.map(function (_, i) { return i; });
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    const order = groups.map(function (_, i) { return i; }).sort(function (a, b) { return groups[a].cx - groups[b].cx; });
    for (let ai = 0; ai < n; ai++) {
      const a = groups[order[ai]];
      let best = -1, bestCost = Infinity;
      for (let bi = ai + 1; bi < n; bi++) {
        const b = groups[order[bi]];
        const dx = b.cx - a.cx;
        if (dx > 6 * hRef) break;
        const dy = Math.abs(b.cy - a.cy);
        if (dy > 0.9 * hRef) continue;
        const cost = dx + 2 * dy;
        if (cost < bestCost) { bestCost = cost; best = order[bi]; }
      }
      if (best >= 0) { const ra = find(order[ai]), rb = find(best); if (ra !== rb) parent[rb] = ra; }
    }
    const byRoot = new Map();
    groups.forEach(function (g, i) { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(g); });
    const rows = [];
    byRoot.forEach(function (list) {
      list.sort(function (a, b) { return Math.abs(a.cx - b.cx) < 0.3 * hRef ? a.cy - b.cy : a.cx - b.cx; });
      rows.push(list);
    });
    const meanY = function (r) { return r.reduce(function (s2, g) { return s2 + g.cy; }, 0) / r.length; };
    rows.sort(function (a, b) { return meanY(a) - meanY(b); });
    rows.forEach(function (r, idx) { r.forEach(function (g, j) { g.row = idx; g.rowStart = j === 0; }); });
    return rows;
  }

  // two small marks stacked on each other that could be one character (":" ";" or an apostrophe over its comma)
  function stackable(a, b, hRef) {
    if (a.h >= 0.55 * hRef || b.h >= 0.55 * hRef) return false;
    const gapY = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) - 1;
    return gapY > 0 && gapY <= 0.6 * hRef && Math.abs(a.cx - b.cx) <= 0.35 * hRef;
  }
  function mergeTwo(a, b) {
    const x0 = Math.min(a.x0, b.x0), y0 = Math.min(a.y0, b.y0), x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
    return { comps: a.comps.concat(b.comps), x0: x0, y0: y0, x1: x1, y1: y1, area: a.area + b.area, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, row: a.row, rowStart: a.rowStart };
  }

  // The writer wrote the same comma dozens of times, so the commas form a tight cluster of near-identical marks.
  // Find that cluster and remember what "this person's comma" looks like: far more reliable than a size rule,
  // because a small lowercase letter (a, c, e, m, n, u, w, x...) is about as tall as a comma.
  function commaProfile(groups, hRef) {
    const cand = groups.filter(function (g) { return g.h < 0.95 * hRef && g.h >= 0.2 * hRef && g.area >= 20; });
    const like = function (a, b) {
      return Math.abs(Math.log(a.w / b.w)) < 0.3 && Math.abs(Math.log(a.h / b.h)) < 0.3 && Math.abs(Math.log(a.area / b.area)) < 0.5;
    };
    let best = null;
    cand.forEach(function (g) {
      const nb = cand.filter(function (o) { return like(g, o); });
      if (!best || nb.length > best.length) best = nb;
    });
    if (!best || best.length < 25) return null; // no clear cluster: fall back to plain size rules
    const med = function (f) { return median(best.map(f)); };
    return { w: med(function (g) { return g.w; }), h: med(function (g) { return g.h; }), area: med(function (g) { return g.area; }), n: best.length };
  }
  // 0 = exactly like this writer's comma, about 1 = the edge of what still looks like one
  function commaDist(g, proto) {
    return Math.max(Math.abs(Math.log(g.w / proto.w)) / 0.4, Math.abs(Math.log(g.h / proto.h)) / 0.4, Math.abs(Math.log(Math.max(1, g.area) / proto.area)) / 0.7);
  }

  // A comma that touches its letter ("4,"  "),") ends up in the same blob. Look for a comma-shaped piece hanging off
  // the lower right of the glyph and cut it away. Thin necks are found by shrinking the mask a pixel or two.
  function splitFusedComma(c, proto) {
    if (!proto) return c;
    const mw = c.mw, mh = c.mh, m = c.mask, n = mw * mh;
    function erode(src) {
      const out = new Uint8Array(n);
      for (let y = 1; y < mh - 1; y++) {
        for (let x = 1; x < mw - 1; x++) {
          const i = y * mw + x;
          if (src[i] && src[i - 1] && src[i + 1] && src[i - mw] && src[i + mw]) out[i] = 1;
        }
      }
      return out;
    }
    let e = m;
    for (let t = 1; t <= 2; t++) {
      e = erode(e);
      const lab = new Int16Array(n);
      let nl = 0;
      for (let s0 = 0; s0 < n; s0++) {
        if (!e[s0] || lab[s0]) continue;
        nl++; lab[s0] = nl;
        const stack = [s0];
        while (stack.length) {
          const p0 = stack.pop();
          const y = (p0 / mw) | 0, x = p0 - y * mw;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy, nx = x + dx;
            if (ny < 0 || ny >= mh || nx < 0 || nx >= mw) continue;
            const q = ny * mw + nx;
            if (e[q] && !lab[q]) { lab[q] = nl; stack.push(q); }
          }
        }
      }
      if (nl < 2) continue;
      // give every ink pixel to the nearest surviving piece
      const owner = new Int16Array(n);
      let frontier = [];
      for (let i = 0; i < n; i++) if (lab[i]) { owner[i] = lab[i]; frontier.push(i); }
      for (let step = 0; step < t + 2 && frontier.length; step++) {
        const next = [];
        frontier.forEach(function (p0) {
          const y = (p0 / mw) | 0, x = p0 - y * mw;
          [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
            const ny = y + d[1], nx = x + d[0];
            if (ny < 0 || ny >= mh || nx < 0 || nx >= mw) return;
            const q = ny * mw + nx;
            if (m[q] && !owner[q]) { owner[q] = owner[p0]; next.push(q); }
          });
        });
        frontier = next;
      }
      const st = [];
      for (let l = 0; l <= nl; l++) st.push({ x0: mw, y0: mh, x1: -1, y1: -1, area: 0 });
      for (let i = 0; i < n; i++) {
        const l = owner[i];
        if (!l) continue;
        const y = (i / mw) | 0, x = i - y * mw, q = st[l];
        if (x < q.x0) q.x0 = x; if (x > q.x1) q.x1 = x; if (y < q.y0) q.y0 = y; if (y > q.y1) q.y1 = y; q.area++;
      }
      let body = 1;
      for (let l = 2; l <= nl; l++) if (st[l].area > st[body].area) body = l;
      const B = st[body];
      let pick = 0, pickD = 1.0;
      for (let l = 1; l <= nl; l++) {
        if (l === body) continue;
        const q = st[l];
        const d = commaDist({ w: q.x1 - q.x0 + 1, h: q.y1 - q.y0 + 1, area: q.area }, proto);
        const bh = B.y1 - B.y0 + 1;
        const lowerRight = q.y0 >= B.y0 + 0.5 * bh && q.y1 >= B.y1 - 1 && (q.x0 + q.x1) / 2 > B.x0 + 0.5 * (B.x1 - B.x0);
        if (d < pickD && lowerRight && B.area >= 1.5 * q.area) { pickD = d; pick = l; }
      }
      if (!pick) continue;
      const out = new Uint8Array(m);
      for (let i = 0; i < n; i++) if (owner[i] === pick) out[i] = 0;
      let x0 = mw, y0 = mh, x1 = -1, y1 = -1;
      for (let i = 0; i < n; i++) if (out[i]) { const y = (i / mw) | 0, x = i - y * mw; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) return c;
      const nw = x1 - x0 + 1, nh = y1 - y0 + 1, nm = new Uint8Array(nw * nh);
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) nm[y * nw + x] = out[(y + y0) * mw + x + x0];
      return { mask: nm, mw: nw, mh: nh, ox: c.ox + x0, oy: c.oy + y0 };
    }
    return c;
  }

  // How believable is it that this mark is that character? (0 = fine; bigger = less likely)
  function itemCost(it, g, hRef, proto) {
    const r = g.h / hRef, ch = it.ch;
    if (proto && (it.kind === "cap" || it.kind === "low" || it.kind === "digit" || "!?()&".indexOf(ch) >= 0) && commaDist(g, proto) < 0.7) {
      return 2 + (it.kind === "cap" || it.kind === "digit" ? 1 : 0); // looks just like a comma: probably not a letter
    }
    if (it.kind === "cap" || it.kind === "digit") return r < 0.55 ? (0.55 - r) * 8 : (r > 1.7 ? (r - 1.7) * 4 : 0);
    if (it.kind === "low") return r < 0.2 ? (0.2 - r) * 8 : (r > 1.8 ? (r - 1.8) * 4 : 0);
    if (ch === "." || ch === "-") return r > 0.5 ? (r - 0.5) * 8 : 0;
    if (ch === ":" || ch === ";" || ch === "'") return r > 0.9 ? (r - 0.9) * 6 : 0;
    return r < 0.5 ? (0.5 - r) * 8 : 0; // ! ? ( ) &
  }
  // How believable is it that this mark is the comma written after that item?
  function commaCost(item, g, hRef, proto) {
    let c = 0;
    const r = g.h / hRef;
    if (proto) {
      const d = commaDist(g, proto);
      if (d > 1) c += Math.min(4, (d - 1) * 2); // does not look like this writer's comma
    } else if (r > 0.8) c += 3 + (r - 0.8) * 8; // too big to be a comma
    const dx = (g.x0 - item.x1) / hRef; // gap between the item's right edge and the comma
    if (dx > 1.2) c += (dx - 1.2) * 1.5;
    if (dx < -0.8) c += (-0.8 - dx) * 1.5;
    const dy = (g.cy - item.cy) / hRef; // positive = lower than the item's middle
    if (dy < -0.5) c += (-0.5 - dy) * 3;
    if (dy > 1.2) c += (dy - 1.2) * 3;
    return c;
  }
  function skipCost(g, hRef, proto) {
    if (proto && commaDist(g, proto) < 0.8) return 2.6; // a real comma: dropping it is a bad explanation
    return 0.3 + 2.2 * Math.min(1, g.h / hRef);
  }
  var _unusedSkip = function () {}; // ignoring a speck is cheap, ignoring a letter is not

  // Finds the best way to read the marks (in reading order) as "item, comma, item, comma ..." for the whole list.
  // Instead of trusting each mark in turn, it considers skipping stray marks, a missing comma, and stacked marks
  // that are one character, and keeps the cheapest overall explanation.
  function alignSequence(seq, items, hRef, proto) {
    const M = seq.length, N = items.length;
    const INF = 1e9, WINDOW = 8, CWINDOW = 6, MISSING_COMMA = 3.5;
    const pre = new Float64Array(M + 1);
    for (let i = 0; i < M; i++) pre[i + 1] = pre[i] + skipCost(seq[i], hRef, proto);
    const trail = new Float64Array(M + 1); // cost of ignoring everything from node k to the end
    for (let i = M - 1; i >= 0; i--) trail[i] = trail[i + 1] + 0.05 + 1.2 * Math.min(1, seq[i].h / hRef);
    const merged = new Array(M);
    for (let i = 0; i + 1 < M; i++) merged[i] = stackable(seq[i], seq[i + 1], hRef) ? mergeTwo(seq[i], seq[i + 1]) : null;

    const size = (M + 2) * (N + 1);
    const dp = new Float64Array(size).fill(INF);
    const bk = new Int32Array(size).fill(-1), bj = new Int32Array(size).fill(-1), bm = new Int8Array(size), bc = new Int32Array(size).fill(-1);
    const at = function (k, i) { return k * (N + 1) + i; };
    dp[at(0, 0)] = 0;
    for (let k = 0; k <= M; k++) {
      for (let i = 0; i < N; i++) {
        const cur = dp[at(k, i)];
        if (cur >= INF) continue;
        for (let j = k; j <= Math.min(k + WINDOW, M - 1); j++) {
          const base = cur + (pre[j] - pre[k]);
          for (let m = 0; m < 2; m++) {
            let node = seq[j], e = j + 1;
            if (m === 1) { if (!merged[j]) continue; node = merged[j]; e = j + 2; }
            let b2 = base + itemCost(items[i], node, hRef, proto);
            if (m === 0 && (items[i].ch === ":" || items[i].ch === ";") && (merged[j] || (j > 0 && merged[j - 1]))) b2 += 1.5;
            const last = i === N - 1;
            // (a) no comma written after this item
            let t = at(e, i + 1), v = b2 + (last ? 0 : MISSING_COMMA);
            if (v < dp[t]) { dp[t] = v; bk[t] = k; bj[t] = j; bm[t] = m; bc[t] = -1; }
            // (b) a comma a little further on (marks in between are ignored)
            for (let c = e; c <= Math.min(e + CWINDOW, M - 1); c++) {
              t = at(c + 1, i + 1);
              v = b2 + (pre[c] - pre[e]) + commaCost(node, seq[c], hRef, proto);
              if (v < dp[t]) { dp[t] = v; bk[t] = k; bj[t] = j; bm[t] = m; bc[t] = c; }
            }
          }
        }
      }
    }
    let bestK = -1, best = INF;
    for (let k = 0; k <= M; k++) {
      const v = dp[at(k, N)] + trail[k]; // specks after the last character are free, letter-sized marks are not
      if (v < best) { best = v; bestK = k; }
    }
    if (bestK < 0) return null;
    const placed = [], used = new Uint8Array(M);
    let k = bestK, i = N;
    while (i > 0) {
      const t = at(k, i);
      const j = bj[t], m = bm[t], c = bc[t];
      const node = m === 1 ? merged[j] : seq[j];
      placed.push({ item: node, comma: c >= 0 ? seq[c] : null });
      used[j] = 1; if (m === 1) used[j + 1] = 1; if (c >= 0) used[c] = 1;
      k = bk[t]; i--;
    }
    placed.reverse();
    const skipped = [];
    let first = M;
    for (let q = 0; q < M; q++) if (used[q] && q < first) first = q;
    for (let q = 0; q < M; q++) if (!used[q] && q >= first) skipped.push(seq[q]);
    return { placed: placed, skipped: skipped, cost: best };
  }

  // ---------- photo-quality measurements ----------

  function measureQuality(gray, mask, w, h) {
    const paper = [], ink = [];
    for (let i = 0; i < w * h; i += 7) (mask[i] ? ink : paper).push(gray[i]);
    const paperLevel = median(paper), inkLevel = median(ink);
    const contrast = paperLevel - inkLevel;

    // sharpness: how fast brightness changes across the edge of a stroke, compared to the contrast
    const mags = [];
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
        const i = y * w + x;
        if (!mask[i]) continue;
        if (mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w]) continue; // inside a stroke, not an edge
        const gx = (gray[i + 1 - w] + 2 * gray[i + 1] + gray[i + 1 + w] - gray[i - 1 - w] - 2 * gray[i - 1] - gray[i - 1 + w]) / 8;
        const gy = (gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]) / 8;
        mags.push(Math.sqrt(gx * gx + gy * gy));
      }
    }
    const sharpness = contrast > 1 ? median(mags) / contrast : 0;

    // shadows: compare the paper brightness in blocks that contain writing
    const block = 64;
    const levels = [];
    for (let by = 0; by + block <= h; by += block) {
      for (let bx = 0; bx + block <= w; bx += block) {
        const vals = [];
        let inkCount = 0;
        for (let y = by; y < by + block; y += 4) {
          for (let x = bx; x < bx + block; x += 4) {
            const i = y * w + x;
            if (mask[i]) inkCount++;
            vals.push(gray[i]);
          }
        }
        if (inkCount > 2) levels.push(percentile(vals, 0.85));
      }
    }
    let shadow = 1;
    if (levels.length > 8) shadow = percentile(levels, 0.08) / Math.max(1, percentile(levels, 0.92));
    return { paperLevel: paperLevel, inkLevel: inkLevel, contrast: contrast, sharpness: sharpness, shadow: shadow };
  }

  // ---------- main ----------

  function read(img, options) {
    options = options || {};
    const items = CS().ITEMS;
    const N = items.length;
    const result = { ok: false, errors: [], warnings: [], glyphs: {}, comma: null, overlay: null, stats: {} };
    function fail(code, title, detail) { result.errors.push({ code: code, title: title, detail: detail || "" }); }

    if (img.width < 700 || img.height < 500) {
      fail("small", "That photo is too small to read.", "Take the photo again with your phone's normal camera, close enough that the writing fills the picture.");
      return result;
    }

    let w = img.width, h = img.height;
    let gray = toGray(img);

    // 1) first look: find the tilt of the lines of writing, then straighten
    let mask = inkMask(gray, w, h);
    const region0 = paperRegion(gray, w, h);
    restrictToPage(mask, w, h, region0);
    const tilt = findTilt(mask, w, h);
    result.stats.tilt = tilt;
    if (Math.abs(tilt) > 0.25) {
      // the corners revealed by rotating are filled with the table's tone (or the page's, if there is no table)
      // so that the "paper on a table" check still sees a dark surround afterwards
      const samples = [];
      for (let i = 0; i < gray.length; i += 13) {
        if (region0) {
          const y = (i / w) | 0, x = i - y * w;
          if (region0.page[Math.min(region0.lh - 1, (y / region0.f) | 0) * region0.lw + Math.min(region0.lw - 1, (x / region0.f) | 0)]) continue;
        }
        samples.push(gray[i]);
      }
      const rot = rotateGray(gray, w, h, tilt, median(samples));
      gray = rot.gray; w = rot.w; h = rot.h;
      mask = inkMask(gray, w, h);
      restrictToPage(mask, w, h, paperRegion(gray, w, h));
    }

    let inkPixels = 0;
    for (let i = 0; i < mask.length; i++) inkPixels += mask[i];
    result.stats.inkFraction = inkPixels / (w * h);

    const quality = measureQuality(gray, mask, w, h);
    result.stats.quality = quality;

    // 2) blobs
    const lab = labelBlobs(mask, w, h);
    const big = Math.max(w, h) * 0.3;
    const kept = lab.comps.filter(function (c) {
      const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
      if (c.area < 14) return false;
      if (cw > big || ch > big) return false;
      if (c.x0 <= 1 || c.y0 <= 1 || c.x1 >= w - 2 || c.y1 >= h - 2) return false;
      return true;
    });
    result.stats.blobs = kept.length;

    result.overlay = { w: w, h: h, gray: gray, boxes: [] };

    if (kept.length < 20) {
      fail("nothing", "I can't see enough writing in that photo.",
        "Use dark ink on plain white paper, fill the picture with the page, and make sure the room is well lit.");
      return result;
    }
    if (quality.contrast < 55) {
      fail("faint", "The writing is too faint.", "Go over it with a dark pen or marker (pencil is usually too light), then take the photo again in good light.");
      return result;
    }

    const heights = kept.filter(function (c) { return c.area >= 25; }).map(function (c) { return c.y1 - c.y0 + 1; });
    const hRef = percentile(heights, 0.75);
    result.stats.hRef = hRef;

    // 3) characters and rows
    const earlyProto = commaProfile(kept.map(function (c) { return { w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1, area: c.area }; }), hRef);
    let groups = mergeIntoGroups(kept, hRef, earlyProto).filter(function (g) { return g.area >= 14; });
    groups = keepTextRegion(groups, hRef);
    const rows = chainIntoRows(groups, hRef);
    if (options.debug) result.debug = { mask: mask, w: w, h: h, groups: groups, rows: rows, hRef: hRef };
    const seq = [];
    rows.forEach(function (r) { r.forEach(function (g) { seq.push(g); }); });
    result.stats.groups = seq.length;
    result.stats.rows = rows.length;

    // 4) match the marks to the list: item, comma, item, comma ... (skipping stray marks)
    const proto = earlyProto || commaProfile(groups, hRef);
    result.stats.comma = proto;
    const aligned = alignSequence(seq, items, hRef, proto);
    if (!aligned) {
      fail("count", "I found only about " + Math.floor(seq.length / 2) + " of " + N + " characters.",
        "Check that you wrote the whole list, with a comma after every item, and that the whole page is in the photo.");
      return result;
    }
    result.stats.alignCost = aligned.cost;
    const found = aligned.placed.map(function (p) { return p.item; });
    const commas = aligned.placed.filter(function (p) { return p.comma; }).map(function (p) { return p.comma; });
    const extras = aligned.skipped;
    result.stats.missingCommas = aligned.placed.length - commas.length;
    if (extras.length) {
      result.warnings.push({ code: "extras", title: "I ignored " + extras.length + " stray mark" + (extras.length > 1 ? "s" : "") + " on the page.", detail: "Specks, smudges and marks that didn’t belong to a character." });
    }

    // overlay boxes, labelled with what each box was taken to be
    found.forEach(function (g, i) {
      result.overlay.boxes.push({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, kind: "item", label: items[i].ch });
    });
    commas.forEach(function (g) {
      result.overlay.boxes.push({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, kind: "comma", label: "," });
    });
    extras.forEach(function (g) {
      result.overlay.boxes.push({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, kind: "extra", label: "?" });
    });

    // 5) sizes: the baseline and writing size of every row
    const rowInfo = {};
    rows.forEach(function (_, ri) { rowInfo[ri] = { bottoms: [], allBottoms: [], bx: [], by: [], caps: [], digits: [] }; });
    found.forEach(function (g, i) {
      const it = items[i];
      const r = rowInfo[g.row];
      r.allBottoms.push(g.y1 + 1);
      if (it.baselineOK) { r.bottoms.push(g.y1 + 1); r.bx.push(g.cx); r.by.push(g.y1 + 1); }
    });
    Object.keys(rowInfo).forEach(function (k) {
      const r = rowInfo[k];
      r.baseline = r.bottoms.length ? median(r.bottoms) : (r.allBottoms.length ? median(r.allBottoms) : 0);
      // Handwriting on plain paper drifts and waves, so the baseline AT a letter is whatever its nearest letters
      // sit on (median of the closest few), not one straight line for the whole row.
      // One robust slope for the whole row (Theil-Sen: shrugs off odd letters) gives the overall lean of the line.
      // Then the nearest few letters adjust it locally, so a wavy line is followed without wild guesses far
      // from any measured letter (a line of punctuation may have only a few reliable letters at one end).
      let rowSlope = 0;
      if (r.bx.length >= 6) {
        const sl = [];
        for (let p = 0; p < r.bx.length; p++) for (let q = p + 1; q < r.bx.length; q++) if (Math.abs(r.bx[q] - r.bx[p]) > 60) sl.push((r.by[q] - r.by[p]) / (r.bx[q] - r.bx[p]));
        if (sl.length) rowSlope = Math.max(-0.08, Math.min(0.08, median(sl)));
      }
      r.slope = rowSlope;
      r.baselineAt = function (x) {
        if (!r.bx.length) return r.baseline;
        const line = function (xx) { return rowSlope * xx; };
        const idx = r.bx.map(function (_, j) { return j; }).sort(function (p, q) { return Math.abs(r.bx[p] - x) - Math.abs(r.bx[q] - x); }).slice(0, 6);
        const resid = median(idx.map(function (j) { return r.by[j] - line(r.bx[j]); }));
        // never extend the line beyond the measured letters: hold it steady there instead of guessing further
        const xc = Math.max(Math.min.apply(null, r.bx), Math.min(Math.max.apply(null, r.bx), x));
        return resid + line(xc);
      };
    });
    found.forEach(function (g, i) {
      const it = items[i];
      const r = rowInfo[g.row];
      const height = r.baselineAt(g.cx) - g.y0;
      if (it.capRef) r.caps.push(height);
      else if (it.kind === "digit") r.digits.push(height);
    });
    const rowCaps = [];
    Object.keys(rowInfo).forEach(function (k) {
      const r = rowInfo[k];
      r.capRef = r.caps.length >= 2 ? median(r.caps) : (r.digits.length >= 2 ? median(r.digits) : 0);
      if (r.capRef > 0) rowCaps.push(r.capRef);
    });
    const globalCap = rowCaps.length ? median(rowCaps) : hRef;
    Object.keys(rowInfo).forEach(function (k) {
      const r = rowInfo[k];
      let ref = r.capRef > 0 ? r.capRef : globalCap;
      ref = Math.min(Math.max(ref, 0.65 * globalCap), 1.5 * globalCap);
      r.f = 700 / ref; // font units per pixel in this row
    });

    // 5b) does the order make sense? A stray mark or a split-in-two letter shifts every later character
    // by one slot, and would quietly build a scrambled font. Check each box has a believable size for the
    // character it was assigned (a capital is tall, a full stop is tiny ...).
    const oddOnes = [];
    found.forEach(function (g, i) {
      const it = items[i], ch = it.ch;
      const cap = 700 / rowInfo[g.row].f; // this row's capital height in pixels
      const ratio = g.h / cap;
      let odd = false;
      if (it.kind === "cap" || it.kind === "digit") odd = ratio < 0.55;
      else if (it.kind === "low") odd = ratio < 0.2 || ratio > 1.8;
      else if (ch === ".") odd = ratio > 0.5;
      else if (ch === "-") odd = ratio > 0.5;
      else if (ch === ":" || ch === ";" || ch === "'") odd = ratio > 0.9;
      else odd = ratio < 0.5; // ! ? ( ) &
      if (odd) oddOnes.push(i);
    });
    if (oddOnes.length >= 3) {
      const g = found[oddOnes[0]];
      result.overlay.boxes.push({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, kind: "problem", label: "!" });
      fail("order", "Something looks out of order around “" + items[oddOnes[0]].ch + "”.",
        "A stray mark, or one letter that came out in two pieces, can shift everything after it. Check the boxes on the photo: each should hold exactly one character, in the order of the list. Wipe off any smudges and take the photo again.");
      return result;
    }

    // 6) cut each character's pixels out
    function cut(g) {
      const mw = g.w, mh = g.h;
      const m = new Uint8Array(mw * mh);
      g.comps.forEach(function (c) {
        for (let y = c.y0; y <= c.y1; y++) {
          for (let x = c.x0; x <= c.x1; x++) {
            if (lab.labels[y * w + x] === c.id) m[(y - g.y0) * mw + (x - g.x0)] = 1;
          }
        }
      });
      return { mask: m, mw: mw, mh: mh, ox: g.x0, oy: g.y0 };
    }
    found.forEach(function (g, i) {
      const r = rowInfo[g.row];
      let c = cut(g);
      if (".'-:;".indexOf(items[i].ch) < 0) c = splitFusedComma(c, proto);
      c.baseline = r.baselineAt(g.cx);
      const bottom = c.oy + c.mh;
      if ((items[i].baselineOK || ".:!?".indexOf(items[i].ch) >= 0) && Math.min(Math.abs(bottom - c.baseline), Math.abs(bottom - r.baseline)) <= 0.3 * (700 / r.f)) c.baseline = bottom; // snap onto the line
      c.f = r.f;
      c.ch = items[i].ch;
      result.glyphs[items[i].ch] = c;
    });
    if (commas.length) {
      const sorted = commas.slice().sort(function (a, b) { return a.area - b.area; });
      const g = sorted[sorted.length >> 1];
      const r = rowInfo[g.row] || rowInfo[0];
      const c = cut(g);
      c.baseline = r.baselineAt(g.cx);
      c.f = r.f;
      c.ch = ",";
      result.comma = c;
    }

    // 7) soft warnings about the photo (the reading worked, but it could be better)
    if (quality.sharpness > 0 && quality.sharpness < 0.13) {
      result.warnings.push({ code: "blur", title: "The photo looks a little blurry.", detail: "Your font will have slightly soft edges. For crisper letters, hold the phone steady and tap the screen to focus." });
    }
    if (quality.shadow < 0.72) {
      result.warnings.push({ code: "shadow", title: "There is a shadow or uneven light across the page.", detail: "It worked this time. If any letter looks off, try again near a window with no shadow of your hand or phone." });
    }
    if (Math.abs(tilt) > 6) {
      result.warnings.push({ code: "tilt", title: "The page was quite tilted.", detail: "I straightened it, but photographing from directly above gives the best result." });
    }

    result.ok = true;
    return result;
  }

  HF.reader = { read: read, _internals: { inkMask: inkMask, findTilt: findTilt, labelBlobs: labelBlobs, mergeIntoGroups: mergeIntoGroups, chainIntoRows: chainIntoRows, measureQuality: measureQuality, toGray: toGray, splitFusedComma: splitFusedComma } };
})();
