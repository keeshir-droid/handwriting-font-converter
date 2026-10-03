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
  function mergeIntoGroups(comps, hRef) {
    const parent = comps.map(function (_, i) { return i; });
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }
    const order = comps.map(function (_, i) { return i; }).sort(function (a, b) { return comps[a].x0 - comps[b].x0; });
    // Pieces stacked on top of each other (a dot above a stem) may be a little off to the side.
    // Pieces side by side (a comma next to a letter) must really overlap, or they are separate.
    // Stacked pieces join when their centres line up (a dot over a stem), not merely when they are near.
    const tolSide = 0.03 * hRef, maxStackGap = 0.38 * hRef, centreTol = 0.2 * hRef;
    for (let ai = 0; ai < order.length; ai++) {
      const a = comps[order[ai]];
      for (let bi = ai + 1; bi < order.length; bi++) {
        const b = comps[order[bi]];
        if (b.x0 - centreTol > a.x1) break; // sorted by left edge: nothing further right can match
        const gapY = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) - 1;
        const overlapX = !(a.x0 - tolSide > b.x1 || b.x0 - tolSide > a.x1);
        let join = false;
        if (gapY > 0) {
          const dcx = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2);
          join = gapY <= maxStackGap && (overlapX || dcx <= centreTol);
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

  function sortIntoRows(groups, hRef) {
    const byY = groups.slice().sort(function (a, b) { return a.cy - b.cy; });
    const rows = [];
    let cur = [];
    for (let i = 0; i < byY.length; i++) {
      if (cur.length && byY[i].cy - byY[i - 1].cy > 0.6 * hRef) { rows.push(cur); cur = []; }
      cur.push(byY[i]);
    }
    if (cur.length) rows.push(cur);
    rows.forEach(function (r, idx) {
      r.sort(function (a, b) { return a.cx - b.cx; });
      r.forEach(function (g, j) { g.row = idx; g.rowStart = j === 0; });
    });
    return rows;
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
    const groups = mergeIntoGroups(kept, hRef).filter(function (g) { return g.area >= 14; });
    const rows = sortIntoRows(groups, hRef);
    const seq = [];
    rows.forEach(function (r) { r.forEach(function (g) { seq.push(g); }); });
    result.stats.groups = seq.length;
    result.stats.rows = rows.length;

    // 4) walk through: item, comma, item, comma ...
    const found = [], commas = [], extras = [];
    let state = "item";
    let problem = null;
    for (let gi = 0; gi < seq.length && !problem; gi++) {
      const g = seq[gi];
      if (state === "item") {
        if (found.length >= N) { extras.push(g); continue; }
        found.push(g);
        state = "comma";
      } else {
        const looksLikeLetter = g.h >= 0.8 * hRef;
        if (found.length >= N) {
          if (!looksLikeLetter) commas.push(g); else extras.push(g);
          state = "item";
        } else if (!looksLikeLetter) {
          commas.push(g);
          state = "item";
        } else if (g.rowStart) {
          // a missing comma at the end of a line is fine
          result.stats.missingLineEndCommas = (result.stats.missingLineEndCommas || 0) + 1;
          found.push(g);
          state = "comma";
        } else {
          problem = { group: g, after: found.length - 1 };
        }
      }
    }
    if (found.length >= N && extras.length) {
      result.warnings.push({ code: "extras", title: "I ignored " + extras.length + " extra mark" + (extras.length > 1 ? "s" : "") + " after the last character.", detail: "" });
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

    if (problem) {
      const g = problem.group;
      result.overlay.boxes.push({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, kind: "problem", label: "!" });
      const prev = problem.after >= 0 ? items[problem.after].ch : null;
      fail("comma", "I think a comma is missing" + (prev ? " after the “" + prev + "”" : "") + ".",
        "I found a letter where I expected a comma (the red box). Put a comma after every character and leave a little space before the next one, then take the photo again.");
      return result;
    }
    if (found.length < N) {
      const last = found.length ? items[found.length - 1].ch : null;
      fail("count", "I found " + found.length + " of " + N + " characters.",
        (last ? "I got as far as “" + last + "”. " : "") +
        "This usually means two letters are touching, a comma is missing, or the page is cut off. Check the boxes on the photo: each should hold one character. Leave more space between characters and between lines.");
      return result;
    }

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
      // handwriting on plain paper drifts up or down along a line: fit a sloped baseline y = a + b*x
      r.slope = 0; r.offset = r.baseline;
      if (r.bx.length >= 6) {
        let xs = r.bx, ys = r.by;
        for (let pass = 0; pass < 2; pass++) {
          const n = xs.length;
          let sx = 0, sy = 0, sxx = 0, sxy = 0;
          for (let j = 0; j < n; j++) { sx += xs[j]; sy += ys[j]; sxx += xs[j] * xs[j]; sxy += xs[j] * ys[j]; }
          const den = n * sxx - sx * sx;
          if (den <= 0) break;
          const b = (n * sxy - sx * sy) / den, a = (sy - b * sx) / n;
          const res = ys.map(function (y, j) { return Math.abs(y - (a + b * xs[j])); });
          r.slope = b; r.offset = a;
          if (pass === 0) { // drop letters far from the line (a wobbly one, a mis-measured one), then refit
            const cut = Math.max(3, 2.5 * median(res));
            const nx = [], ny = [];
            for (let j = 0; j < n; j++) if (res[j] <= cut) { nx.push(xs[j]); ny.push(ys[j]); }
            if (nx.length < 6) break;
            xs = nx; ys = ny;
          }
        }
        // keep the slope only if it clearly beats a flat line (otherwise it is just chasing wobble)
        const flatMad = median(r.by.map(function (y) { return Math.abs(y - r.baseline); }));
        const fitMad = median(r.bx.map(function (x, j) { return Math.abs(r.by[j] - (r.offset + r.slope * x)); }));
        if (Math.abs(r.slope) > 0.15 || fitMad > 0.6 * flatMad) { r.slope = 0; r.offset = r.baseline; }
      }
      r.baselineAt = function (x) { return r.offset + r.slope * x; };
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
      const c = cut(g);
      c.baseline = r.baselineAt(g.cx);
      if (items[i].baselineOK && Math.abs(g.y1 + 1 - c.baseline) <= 0.3 * (700 / r.f)) c.baseline = g.y1 + 1; // snap onto the line
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

  HF.reader = { read: read, _internals: { inkMask: inkMask, findTilt: findTilt, labelBlobs: labelBlobs, mergeIntoGroups: mergeIntoGroups, sortIntoRows: sortIntoRows, measureQuality: measureQuality, toGray: toGray } };
})();
