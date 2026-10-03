// Writes a one-page vector PDF of a laid-out page. No libraries.
//
//   HF.pdfwriter.buildPDF({ pageW, pageH, layout, lib, ink, paper, lines, title }) -> Uint8Array
//
//   layout = HF.layout.layoutText(...) result, lib = HF.library result, ink / paper = "#rrggbb"
//   lines  = draw the ruled lines (layout.ruleYs)
//
// Every distinct letter becomes one reusable Form XObject (its outline as path operators); the page
// then stamps copies with a transform each. Text stays crisp at any zoom and the file stays small.
(function () {
  const HF = (globalThis.HF = globalThis.HF || {});

  function parseHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    const v = m ? parseInt(m[1], 16) : 0;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  function rgbOps(c) { return (c[0] / 255).toFixed(4) + " " + (c[1] / 255).toFixed(4) + " " + (c[2] / 255).toFixed(4); }
  function mix(a, b, t) { return [0, 1, 2].map(function (i) { return Math.round(a[i] + (b[i] - a[i]) * t); }); }
  function num(v, d) { const s = v.toFixed(d == null ? 4 : d); return s.indexOf(".") < 0 ? s : s.replace(/0+$/, "").replace(/\.$/, ""); }

  // outline (font units) -> PDF path operators; each quadratic curve is raised to a cubic
  function pathOps(contours) {
    const out = [];
    contours.forEach(function (c) {
      let cx = 0, cy = 0, sx = 0, sy = 0;
      HF.outline.walk(c,
        function (x, y) { out.push(num(x, 2) + " " + num(y, 2) + " m"); cx = sx = x; cy = sy = y; },
        function (x, y) { out.push(num(x, 2) + " " + num(y, 2) + " l"); cx = x; cy = y; },
        function (qx, qy, x, y) {
          const c1x = cx + (2 / 3) * (qx - cx), c1y = cy + (2 / 3) * (qy - cy);
          const c2x = x + (2 / 3) * (qx - x), c2y = y + (2 / 3) * (qy - y);
          out.push(num(c1x, 2) + " " + num(c1y, 2) + " " + num(c2x, 2) + " " + num(c2y, 2) + " " + num(x, 2) + " " + num(y, 2) + " c");
          cx = x; cy = y;
        });
      out.push("h");
    });
    out.push("f");
    return out.join("\n");
  }

  function pdfString(s) { // literal string, ASCII only
    return "(" + String(s).replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1") + ")";
  }

  function buildPDF(opts) {
    const W = opts.pageW, H = opts.pageH;
    const ink = parseHex(opts.ink || "#1a1a1a"), paper = parseHex(opts.paper || "#ffffff");
    const layout = opts.layout, lib = opts.lib;

    // one form per distinct character used
    const names = {}; // ch -> "G<n>"
    const used = [];
    layout.glyphs.forEach(function (g) { if (!names[g.ch]) { names[g.ch] = "G" + used.length; used.push(g.ch); } });

    // page content
    const c = [];
    c.push(rgbOps(paper) + " rg");
    c.push("0 0 " + num(W, 2) + " " + num(H, 2) + " re f");
    if (opts.lines && layout.ruleYs && layout.ruleYs.length) {
      c.push(rgbOps(mix(paper, ink, 0.16)) + " RG");
      c.push("0.6 w");
      layout.ruleYs.forEach(function (y) {
        c.push(num(layout.margin, 2) + " " + num(H - y, 2) + " m " + num(W - layout.margin, 2) + " " + num(H - y, 2) + " l S");
      });
    }
    c.push(rgbOps(ink) + " rg");
    layout.glyphs.forEach(function (g) {
      const cs = Math.cos(g.rot), sn = Math.sin(g.rot);
      // matrix in y-down page coordinates, then flipped for PDF (y up)
      const a = cs * g.s, b = sn * g.s, cc = sn * g.s, d = -cs * g.s;
      const e = g.x - cs * g.s * g.cx, f = g.y - sn * g.s * g.cx;
      c.push("q " + num(a, 7) + " " + num(-b, 7) + " " + num(cc, 7) + " " + num(-d, 7) + " " + num(e, 3) + " " + num(H - f, 3) + " cm /" + names[g.ch] + " Do Q");
    });
    const content = c.join("\n");

    // objects: 1 catalog, 2 pages, 3 page, 4 content, 5 info, 6.. glyph forms
    const objs = [];
    const xobj = used.map(function (ch, i) { return "/" + names[ch] + " " + (6 + i) + " 0 R"; }).join(" ");
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
    objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + num(W, 2) + " " + num(H, 2) + "] /Resources << /XObject << " + xobj + " >> >> /Contents 4 0 R >>";
    objs[4] = "<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream";
    objs[5] = "<< /Creator (Handwriting Font Converter) /Producer (Handwriting Font Converter) /Title " + pdfString(opts.title || "Handwritten page") + " >>";
    used.forEach(function (ch, i) {
      const body = pathOps(HF.library.resolve(lib, ch) ? lib.glyphs[HF.library.resolve(lib, ch)].contours : []);
      objs[6 + i] = "<< /Type /XObject /Subtype /Form /BBox [-300 -600 1600 1300] /Length " + body.length + " >>\nstream\n" + body + "\nendstream";
    });

    // assemble with a correct cross-reference table (everything is ASCII, so string length = byte length)
    let out = "%PDF-1.4\n%âãÏÓ\n";
    const offsets = [];
    for (let i = 1; i < objs.length; i++) {
      offsets[i] = out.length;
      out += i + " 0 obj\n" + objs[i] + "\nendobj\n";
    }
    const xrefAt = out.length;
    out += "xref\n0 " + objs.length + "\n0000000000 65535 f \n";
    for (let i = 1; i < objs.length; i++) out += ("0000000000" + offsets[i]).slice(-10) + " 00000 n \n";
    out += "trailer\n<< /Size " + objs.length + " /Root 1 0 R /Info 5 0 R >>\nstartxref\n" + xrefAt + "\n%%EOF\n";

    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }

  HF.pdfwriter = { buildPDF: buildPDF };
})();
