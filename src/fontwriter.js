// Builds a real TrueType font file (.ttf) from traced outlines. No libraries.
//
//   HF.fontwriter.buildTTF({ familyName, glyphs, aliases }) -> Uint8Array
//
// glyphs  = { "A": { adv, contours }, ... }   keys are single characters; contours as in outline.js
// aliases = { " ": " ", "’": "'" }   extra characters that reuse another character's glyph
//
// Tables written: OS/2, cmap, glyf, head, hhea, hmtx, loca, maxp, name, post.
(function () {
  const HF = (globalThis.HF = globalThis.HF || {});

  const UPM = 1000;

  // ---- tiny big-endian byte writer ----
  function Writer() { this.a = []; }
  Writer.prototype.u8 = function (v) { this.a.push(v & 0xff); return this; };
  Writer.prototype.u16 = function (v) { this.a.push((v >> 8) & 0xff, v & 0xff); return this; };
  Writer.prototype.i16 = function (v) { return this.u16(v < 0 ? v + 65536 : v); };
  Writer.prototype.u32 = function (v) { this.a.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); return this; };
  Writer.prototype.i32 = function (v) { return this.u32(v >>> 0); };
  Writer.prototype.tag = function (s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); return this; };
  Writer.prototype.bytes = function (arr) { for (let i = 0; i < arr.length; i++) this.a.push(arr[i]); return this; };
  Writer.prototype.pad4 = function () { while (this.a.length % 4) this.a.push(0); return this; };
  Writer.prototype.len = function () { return this.a.length; };

  function checksum(bytes) { // sum of big-endian uint32 words, zero padded
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      const w = ((bytes[i] << 24) | ((bytes[i + 1] || 0) << 16) | ((bytes[i + 2] || 0) << 8) | (bytes[i + 3] || 0)) >>> 0;
      sum = (sum + w) >>> 0;
    }
    return sum;
  }

  function clamp16(v) { return Math.max(-32000, Math.min(32000, Math.round(v))); }

  // ---- names ----
  function sanitizeName(name) {
    let s = String(name == null ? "" : name).replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
    if (s.length > 40) s = s.slice(0, 40).trim();
    return s || "My Handwriting";
  }
  function postScriptName(name) {
    let s = sanitizeName(name).replace(/[^A-Za-z0-9]+/g, "");
    if (!s) s = "MyHandwriting";
    return s.slice(0, 60);
  }
  function fileNameFor(name) {
    const s = sanitizeName(name).replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim() || "My Handwriting";
    return s + ".ttf";
  }
  function utf16be(s) { const o = []; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o.push(c >> 8, c & 0xff); } return o; }
  function asciiBytes(s) { const o = []; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o.push(c < 128 && c >= 32 ? c : 63); } return o; }

  // ---- glyph data ----
  function encodeGlyph(contours) {
    // returns { bytes, xMin, yMin, xMax, yMax, nPoints, nContours } (bytes empty if nothing to draw)
    const cs = [];
    contours.forEach(function (c) {
      const pts = [];
      HF.outline.explicit(c).forEach(function (p) {
        const q = { x: clamp16(p.x), y: clamp16(p.y), on: !!p.on };
        const last = pts[pts.length - 1];
        if (last && last.x === q.x && last.y === q.y && last.on === q.on) return; // exact repeat
        pts.push(q);
      });
      while (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y && pts[0].on === pts[pts.length - 1].on) pts.pop();
      if (pts.length >= 3) cs.push(pts);
    });
    if (!cs.length) return { bytes: [], xMin: 0, yMin: 0, xMax: 0, yMax: 0, nPoints: 0, nContours: 0 };
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity, n = 0;
    cs.forEach(function (c) { c.forEach(function (p) { n++; if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x; if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y; }); });
    const w = new Writer();
    w.i16(cs.length).i16(xMin).i16(yMin).i16(xMax).i16(yMax);
    let end = -1;
    cs.forEach(function (c) { end += c.length; w.u16(end); });
    w.u16(0); // no instructions
    cs.forEach(function (c) { c.forEach(function (p) { w.u8(p.on ? 1 : 0); }); }); // flags: on-curve bit only, coordinates as int16
    let px = 0;
    cs.forEach(function (c) { c.forEach(function (p) { w.i16(p.x - px); px = p.x; }); });
    let py = 0;
    cs.forEach(function (c) { c.forEach(function (p) { w.i16(p.y - py); py = p.y; }); });
    w.pad4();
    return { bytes: w.a, xMin: xMin, yMin: yMin, xMax: xMax, yMax: yMax, nPoints: n, nContours: cs.length };
  }

  function notdefContours() {
    const P = function (x, y) { return { x: x, y: y, on: true }; };
    return [
      [P(50, 0), P(50, 700), P(450, 700), P(450, 0)],       // outer, clockwise
      [P(100, 50), P(400, 50), P(400, 650), P(100, 650)],   // inner, counter-clockwise
    ];
  }

  // ---- cmap (format 4) ----
  function buildCmap(map) { // map: array of [codepoint, gid], sorted by codepoint, BMP only
    const segs = [];
    map.forEach(function (e) {
      const last = segs[segs.length - 1];
      if (last && e[0] === last.end + 1 && e[1] === last.startGid + (e[0] - last.start)) last.end = e[0];
      else segs.push({ start: e[0], end: e[0], startGid: e[1] });
    });
    segs.push({ start: 0xffff, end: 0xffff, startGid: 0, last: true });
    const segCount = segs.length;
    let pow = 1, log = 0;
    while (pow * 2 <= segCount) { pow *= 2; log++; }
    const searchRange = pow * 2;
    const sub = new Writer();
    const length = 16 + segCount * 8;
    sub.u16(4).u16(length).u16(0).u16(segCount * 2).u16(searchRange).u16(log).u16(segCount * 2 - searchRange);
    segs.forEach(function (s) { sub.u16(s.end); });
    sub.u16(0);
    segs.forEach(function (s) { sub.u16(s.start); });
    segs.forEach(function (s) { sub.u16(s.last ? 1 : (s.startGid - s.start) & 0xffff); });
    segs.forEach(function () { sub.u16(0); });
    const w = new Writer();
    w.u16(0).u16(2);
    w.u16(0).u16(3).u32(20);
    w.u16(3).u16(1).u32(20);
    w.bytes(sub.a);
    return w.a;
  }

  // ---- name ----
  function buildName(family, ps) {
    const strings = [
      [1, family], [2, "Regular"], [3, ps + ";Handwriting Font Converter;1.0"], [4, family], [5, "Version 1.0"], [6, ps],
    ];
    const recs = []; // platform, encoding, language, nameId, bytes
    strings.forEach(function (s) { recs.push([1, 0, 0, s[0], asciiBytes(s[1])]); });
    strings.forEach(function (s) { recs.push([3, 1, 0x409, s[0], utf16be(s[1])]); });
    recs.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]; });
    const w = new Writer();
    w.u16(0).u16(recs.length).u16(6 + 12 * recs.length);
    let off = 0;
    recs.forEach(function (r) { w.u16(r[0]).u16(r[1]).u16(r[2]).u16(r[3]).u16(r[4].length).u16(off); off += r[4].length; });
    recs.forEach(function (r) { w.bytes(r[4]); });
    return w.a;
  }

  function dateSince1904() {
    const secs = Math.floor(Date.now() / 1000) + 2082844800;
    return [Math.floor(secs / 4294967296), secs >>> 0];
  }

  function buildTTF(opts) {
    const family = sanitizeName(opts.familyName);
    const ps = postScriptName(family);
    const src = opts.glyphs || {};
    const aliases = opts.aliases || {};

    // glyph order: .notdef, then characters by ascending Unicode value
    const chars = Object.keys(src).filter(function (ch) { const cp = ch.codePointAt(0); return ch.length === String.fromCodePoint(cp).length && cp <= 0xffff; })
      .sort(function (a, b) { return a.codePointAt(0) - b.codePointAt(0); });
    const glyphs = [{ ch: null, adv: 500, contours: notdefContours() }];
    chars.forEach(function (ch) { glyphs.push({ ch: ch, adv: src[ch].adv, contours: src[ch].contours || [] }); });
    const gidOf = {};
    glyphs.forEach(function (g, i) { if (g.ch) gidOf[g.ch] = i; });
    const cmapEntries = chars.map(function (ch) { return [ch.codePointAt(0), gidOf[ch]]; });
    Object.keys(aliases).forEach(function (ch) {
      const cp = ch.codePointAt(0);
      if (cp <= 0xffff && gidOf[aliases[ch]] != null && gidOf[ch] == null) cmapEntries.push([cp, gidOf[aliases[ch]]]);
    });
    cmapEntries.sort(function (a, b) { return a[0] - b[0]; });
    // an alias must not clash with a real character
    const dedup = [];
    cmapEntries.forEach(function (e) { if (!dedup.length || dedup[dedup.length - 1][0] !== e[0]) dedup.push(e); });

    // glyf + loca + hmtx
    const glyf = new Writer(), loca = new Writer(), hmtx = new Writer();
    let gxMin = Infinity, gyMin = Infinity, gxMax = -Infinity, gyMax = -Infinity;
    let maxPoints = 0, maxContours = 0, advMax = 0, minLsb = Infinity, minRsb = Infinity, xMaxExtent = -Infinity;
    glyphs.forEach(function (g) {
      loca.u32(glyf.len());
      const e = encodeGlyph(g.contours);
      glyf.bytes(e.bytes);
      const adv = Math.max(0, Math.min(65535, Math.round(g.adv)));
      const lsb = e.nContours ? e.xMin : 0;
      hmtx.u16(adv).i16(lsb);
      if (adv > advMax) advMax = adv;
      if (e.nContours) {
        if (e.xMin < gxMin) gxMin = e.xMin;
        if (e.yMin < gyMin) gyMin = e.yMin;
        if (e.xMax > gxMax) gxMax = e.xMax;
        if (e.yMax > gyMax) gyMax = e.yMax;
        if (e.nPoints > maxPoints) maxPoints = e.nPoints;
        if (e.nContours > maxContours) maxContours = e.nContours;
        if (lsb < minLsb) minLsb = lsb;
        const rsb = adv - e.xMax;
        if (rsb < minRsb) minRsb = rsb;
        if (e.xMax > xMaxExtent) xMaxExtent = e.xMax;
      }
    });
    loca.u32(glyf.len());
    if (gxMin === Infinity) { gxMin = 0; gyMin = 0; gxMax = 0; gyMax = 0; minLsb = 0; minRsb = 0; xMaxExtent = 0; }

    // measurements for OS/2
    const xg = src["x"] && src["x"].contours && src["x"].contours.length ? HF.outline.bounds(src["x"].contours) : null;
    const xHeight = xg ? Math.max(200, Math.min(700, Math.round(xg.y1))) : 480;
    let avgW = 0, avgN = 0;
    glyphs.forEach(function (g, i) { if (i > 0 && g.adv > 0) { avgW += g.adv; avgN++; } });
    avgW = avgN ? Math.round(avgW / avgN) : 500;
    const firstCp = dedup.length ? dedup[0][0] : 32, lastCp = dedup.length ? dedup[dedup.length - 1][0] : 32;
    let range1 = 1, range2 = 0;
    dedup.forEach(function (e) { if (e[0] >= 0x80 && e[0] <= 0xff) range1 |= 2; if (e[0] >= 0x2000 && e[0] <= 0x206f) range1 |= 0x80000000; });
    range1 = range1 >>> 0; range2 = range2 >>> 0;

    const os2 = new Writer();
    os2.u16(4).i16(avgW).u16(400).u16(5).u16(0);
    os2.i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350).i16(50).i16(300).i16(0);
    for (let i = 0; i < 10; i++) os2.u8(0); // panose
    os2.u32(range1).u32(range2).u32(0).u32(0);
    os2.tag("NONE").u16(0x00c0).u16(firstCp).u16(Math.min(lastCp, 0xffff));
    os2.i16(800).i16(-250).i16(200);
    os2.u16(Math.max(1000, gyMax)).u16(Math.max(300, -gyMin));
    os2.u32(1).u32(0);
    os2.i16(xHeight).i16(700).u16(0).u16(32).u16(1);

    const created = dateSince1904();
    const head = new Writer();
    head.u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5).u16(0x000b).u16(UPM);
    head.u32(created[0]).u32(created[1]).u32(created[0]).u32(created[1]);
    head.i16(gxMin).i16(gyMin).i16(gxMax).i16(gyMax).u16(0).u16(8).i16(2).i16(1).i16(0);

    const hhea = new Writer();
    hhea.u32(0x00010000).i16(900).i16(-300).i16(0).u16(advMax).i16(minLsb).i16(minRsb).i16(xMaxExtent);
    hhea.i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(glyphs.length);

    const maxp = new Writer();
    maxp.u32(0x00010000).u16(glyphs.length).u16(maxPoints).u16(maxContours).u16(0).u16(0).u16(1).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);

    const post = new Writer();
    post.u32(0x00030000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);

    const tables = [
      ["OS/2", os2.a], ["cmap", buildCmap(dedup.filter(function (e) { return e[0] <= 0xfffe; }))], ["glyf", glyf.a], ["head", head.a],
      ["hhea", hhea.a], ["hmtx", hmtx.a], ["loca", loca.a], ["maxp", maxp.a], ["name", buildName(family, ps)], ["post", post.a],
    ].sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });

    const n = tables.length;
    let pow = 1, log = 0;
    while (pow * 2 <= n) { pow *= 2; log++; }
    const dirSize = 12 + 16 * n;
    const out = new Writer();
    out.u32(0x00010000).u16(n).u16(pow * 16).u16(log).u16(n * 16 - pow * 16);
    let offset = dirSize;
    const placed = [];
    tables.forEach(function (t) {
      const len = t[1].length;
      out.tag(t[0]).u32(checksum(t[1])).u32(offset).u32(len);
      placed.push({ tag: t[0], offset: offset, data: t[1] });
      offset += (len + 3) & ~3;
    });
    placed.forEach(function (p) { out.bytes(p.data).pad4(); });

    // whole-file checksum goes into head.checkSumAdjustment
    const bytes = Uint8Array.from(out.a);
    const headAt = placed.filter(function (p) { return p.tag === "head"; })[0].offset;
    const adj = (0xb1b0afba - checksum(bytes)) >>> 0;
    bytes[headAt + 8] = (adj >>> 24) & 0xff; bytes[headAt + 9] = (adj >>> 16) & 0xff; bytes[headAt + 10] = (adj >>> 8) & 0xff; bytes[headAt + 11] = adj & 0xff;
    return bytes;
  }

  HF.fontwriter = { buildTTF: buildTTF, sanitizeName: sanitizeName, fileNameFor: fileNameFor };
})();
