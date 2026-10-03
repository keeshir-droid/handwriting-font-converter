// The app: screens, photo intake, writing page, exports, sharing, storage.
// Everything runs in the browser. Nothing is uploaded and nothing is sent anywhere.
(function () {
  const HF = globalThis.HF;
  const $ = function (id) { return document.getElementById(id); };

  const STORE_KEY = "hfc.v1";
  const MAX_SIDE = 2600; // photos are shrunk to this many pixels on the long side before reading
  const FEEDBACK_URL = "https://github.com/keeshir-droid/handwriting-font-converter/issues";

  const INKS = [["Black", "#1A1A1A"], ["Blue", "#1F3F8F"], ["Navy", "#14284B"], ["Green", "#1F5A3C"], ["Burgundy", "#7A1F2B"], ["Purple", "#52308A"], ["Cream", "#F6F1E7"]];
  const PAPERS = [["White", "#FFFFFF"], ["Cream", "#FBF4E4"], ["Blush", "#FBE9E7"], ["Sky", "#E8F1FA"], ["Sage", "#E9F0E4"], ["Night", "#1F2430"]];
  const SAMPLE_NOTE = "Dear friend,\n\nI wish I could hand you this note in person. Since I can't, I wrote it in my own handwriting instead.\n\nMiss you lots.";

  const state = {
    lib: null, name: "My Handwriting",
    ink: "#14284B", paper: "#FBF4E4", lines: false, page: "card", size: 5,
    text: SAMPLE_NOTE,
    pending: null, // { lib } waiting for "Looks great"
  };

  const isTouch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  const narrowMq = window.matchMedia("(max-width: 860px)");

  // ---------------------------------------------------------------- storage (may be blocked: always try/catch)
  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (o && o.v === 1 && o.lib && o.lib.glyphs && o.lib.glyphs["a"]) return o;
    } catch (e) { /* storage unavailable or damaged: carry on without it */ }
    return null;
  }
  let saveTimer = 0;
  function saveNow() {
    if (!state.lib) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, name: state.name, lib: state.lib, ink: state.ink, paper: state.paper, lines: state.lines, page: state.page, size: state.size, text: state.text }));
    } catch (e) { /* ignore */ }
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }

  function roundLib(lib) { // 0.1 font-unit precision is plenty, and keeps the saved data small
    const r = function (v) { return Math.round(v * 10) / 10; };
    Object.keys(lib.glyphs).forEach(function (ch) {
      const g = lib.glyphs[ch];
      g.adv = r(g.adv);
      g.contours = g.contours.map(function (c) { return c.map(function (p) { return { x: r(p.x), y: r(p.y), on: p.on }; }); });
    });
    return lib;
  }

  // ---------------------------------------------------------------- screens
  const screens = ["setup", "review", "write"];
  let current = "setup";
  function show(name) {
    current = name;
    screens.forEach(function (s) { $("screen-" + s).hidden = s !== name; });
    $("topBack").hidden = !(state.lib && name !== "write");
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- setup screen
  function renderList() {
    const el = $("listText");
    el.textContent = "";
    HF.charset.ORDER.forEach(function (ch, i) {
      const s = document.createElement("span");
      s.textContent = ch + ",";
      el.appendChild(s);
      el.appendChild(document.createTextNode(" "));
    });
    const n = document.createElement("span");
    n.className = "num";
    n.textContent = "(" + HF.charset.ORDER.length + " items)";
    el.appendChild(n);
  }

  function setupSavedBanner() {
    const has = !!state.lib;
    $("savedBanner").hidden = !has;
    if (has) $("savedName").textContent = state.name;
    $("topBack").hidden = !(has && current !== "write");
  }

  // ---------------------------------------------------------------- photo intake
  function friendly(title, detail) { return { ok: false, errors: [{ code: "file", title: title, detail: detail }], warnings: [], overlay: null, glyphs: {} }; }

  async function decodeImage(file) {
    // 1) the modern way (respects the phone's rotation flag), 2) without options, 3) an <img> element
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* try the next way */ }
      try { return await createImageBitmap(file); } catch (e) { /* try the next way */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(function () { URL.revokeObjectURL(url); }, 2000); }
  }

  async function readPhoto(file) {
    const bmp = await decodeImage(file);
    const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
    const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return ctx.getImageData(0, 0, w, h);
  }

  function nextPaint() { return new Promise(function (res) { requestAnimationFrame(function () { setTimeout(res, 30); }); }); }

  async function processFile(file) {
    if (!file) return;
    show("review");
    $("reviewBusy").hidden = false;
    $("reviewDone").hidden = true;
    await nextPaint();
    let result;
    try {
      if (file.type && file.type.indexOf("image/") !== 0) {
        result = friendly("That doesn’t look like a photo.", "Please choose a picture (JPG or PNG). PDFs aren’t supported yet. You can take a screenshot of the page and use that.");
      } else {
        let img;
        try { img = await readPhoto(file); }
        catch (e) {
          img = null;
          result = friendly("I couldn’t open that picture.", /heic|heif/i.test((file.type || "") + (file.name || ""))
            ? "It looks like a HEIC photo, which this browser can’t read. Take a screenshot of the photo, or choose a JPG or PNG."
            : "Try a different photo, or take a screenshot of it and use that.");
        }
        if (img) result = HF.reader.read(img);
      }
    } catch (e) {
      result = friendly("Something went wrong while reading the photo.", "Please try again with another photo. (" + (e && e.message ? e.message : "unknown error") + ")");
    }
    showReview(result);
  }

  // ---------------------------------------------------------------- review screen
  function drawOverlay(result) {
    const o = result.overlay;
    const shot = document.querySelector("#screen-review .shot");
    if (!o) { shot.hidden = true; $("legend").hidden = true; return; }
    shot.hidden = false; $("legend").hidden = false;
    const cv = $("shotCanvas");
    cv.width = o.w; cv.height = o.h;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(o.w, o.h);
    for (let i = 0, n = o.w * o.h; i < n; i++) { const v = o.gray[i]; img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    const colors = { item: "#2e9e66", comma: "#8a8a8a", extra: "#e0a800", problem: "#d6402d" };
    const lw = Math.max(2, o.w / 520), fs = Math.max(16, o.w / 58);
    ctx.lineWidth = lw; ctx.font = "600 " + fs + "px system-ui, sans-serif"; ctx.textBaseline = "bottom";
    o.boxes.forEach(function (b) {
      const col = colors[b.kind] || "#888";
      ctx.strokeStyle = col;
      ctx.strokeRect(b.x0 - 2, b.y0 - 2, b.x1 - b.x0 + 5, b.y1 - b.y0 + 5);
      if (b.kind === "item" || b.kind === "problem") {
        const tw = ctx.measureText(b.label).width + 8;
        ctx.fillStyle = col;
        ctx.fillRect(b.x0 - 2, b.y0 - 2 - fs - 2, tw, fs + 2);
        ctx.fillStyle = "#fff";
        ctx.fillText(b.label, b.x0 + 2, b.y0 - 3);
      }
    });
  }

  function svgFor(g) {
    const parts = [];
    g.contours.forEach(function (c) {
      HF.outline.walk(c,
        function (x, y) { parts.push("M" + x.toFixed(1) + " " + (-y).toFixed(1)); },
        function (x, y) { parts.push("L" + x.toFixed(1) + " " + (-y).toFixed(1)); },
        function (qx, qy, x, y) { parts.push("Q" + qx.toFixed(1) + " " + (-qy).toFixed(1) + " " + x.toFixed(1) + " " + (-y).toFixed(1)); });
      parts.push("Z");
    });
    const w = Math.max(g.adv + 60, 700);
    return '<svg viewBox="' + (-30 - (w - g.adv - 60) / 2) + ' -900 ' + w + ' 1200" aria-hidden="true"><path d="' + parts.join("") + '" fill="currentColor"/></svg>';
  }

  function showReview(result) {
    $("reviewBusy").hidden = true;
    $("reviewDone").hidden = false;
    const notices = $("reviewNotices");
    notices.textContent = "";
    function addNotice(kind, title, detail) {
      const d = document.createElement("div");
      d.className = "notice " + kind;
      const b = document.createElement("b"); b.textContent = title; d.appendChild(b);
      if (detail) d.appendChild(document.createTextNode(detail));
      notices.appendChild(d);
    }
    drawOverlay(result);
    $("reviewOk").hidden = true; $("reviewFail").hidden = true;

    if (!result.ok) {
      state.pending = null;
      $("reviewEyebrow").textContent = "Almost";
      $("reviewTitle").textContent = "Let’s try that photo again.";
      $("reviewMsg").textContent = "It’s free to retake, and it usually takes one more try.";
      (result.errors || []).forEach(function (e) { addNotice("bad", e.title, e.detail ? " " + e.detail : ""); });
      $("reviewFail").hidden = false;
      return;
    }

    let built;
    try { built = roundLib(HF.library.build(result)); }
    catch (e) {
      $("reviewEyebrow").textContent = "Almost";
      $("reviewTitle").textContent = "Let’s try that photo again.";
      $("reviewMsg").textContent = "";
      addNotice("bad", "I read the letters but couldn’t turn them into shapes.", " Please try a clearer photo. (" + (e && e.message) + ")");
      $("reviewFail").hidden = false;
      return;
    }
    state.pending = built;
    $("reviewEyebrow").textContent = "Step 2 of 2";
    $("reviewTitle").textContent = "We found all " + HF.charset.ORDER.length + " characters.";
    $("reviewMsg").textContent = "Here they are, rebuilt as smooth shapes. They should look like yours.";
    (result.warnings || []).forEach(function (w) { addNotice("warn", w.title, w.detail ? " " + w.detail : ""); });

    const grid = $("glyphGrid");
    grid.textContent = "";
    HF.charset.ORDER.concat([","]).forEach(function (ch) {
      const g = built.glyphs[ch];
      if (!g) return;
      const t = document.createElement("div");
      t.className = "tile";
      t.innerHTML = svgFor(g);
      const l = document.createElement("span"); l.textContent = ch; t.appendChild(l);
      grid.appendChild(t);
    });
    $("fontName").value = state.name || "My Handwriting";
    $("reviewOk").hidden = false;
  }

  // ---------------------------------------------------------------- writing page
  let cur = null;        // current layout (with page info)
  let paths = {};        // ch -> Path2D
  let fontFace = null;
  let fontBytesCache = null; // { key, bytes }

  function pathFor(ch) {
    if (paths[ch]) return paths[ch];
    const p = new Path2D();
    const g = state.lib.glyphs[ch];
    if (g) g.contours.forEach(function (c) {
      HF.outline.walk(c, function (x, y) { p.moveTo(x, y); }, function (x, y) { p.lineTo(x, y); }, function (qx, qy, x, y) { p.quadraticCurveTo(qx, qy, x, y); });
      p.closePath();
    });
    paths[ch] = p;
    return p;
  }

  function hexToRgb(h) { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
  function lum(h) { const c = hexToRgb(h); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255; }
  function mixHex(a, b, t) { const x = hexToRgb(a), y = hexToRgb(b); return "rgb(" + [0, 1, 2].map(function (i) { return Math.round(x[i] + (y[i] - x[i]) * t); }).join(",") + ")"; }

  function pageSpec() { return HF.layout.PAGES[state.page] || HF.layout.PAGES.card; }

  function makeLayout(text, wobble) {
    const pg = pageSpec();
    return HF.layout.layoutText(text, state.lib, { pageW: pg.w, pageH: pg.h, size: HF.layout.defaultSize(state.page, state.size), wobble: wobble !== false, seed: 1 });
  }

  // draws a layout onto any canvas context; k = pixels per point
  function drawPage(ctx, k, layout, opts) {
    const pg = pageSpec();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = state.paper;
    ctx.fillRect(0, 0, pg.w * k, pg.h * k);
    if (state.lines) {
      ctx.strokeStyle = mixHex(state.paper, state.ink, 0.16);
      ctx.lineWidth = 0.6 * k;
      layout.ruleYs.forEach(function (y) { ctx.beginPath(); ctx.moveTo(layout.margin * k, y * k); ctx.lineTo((pg.w - layout.margin) * k, y * k); ctx.stroke(); });
    }
    ctx.fillStyle = state.ink;
    if (opts && opts.alpha) ctx.globalAlpha = opts.alpha;
    layout.glyphs.forEach(function (g) {
      ctx.save();
      ctx.translate(g.x * k, g.y * k);
      ctx.rotate(g.rot);
      ctx.scale(g.s * k, -g.s * k);
      ctx.translate(-g.cx, 0);
      ctx.fill(pathFor(g.ch));
      ctx.restore();
    });
    ctx.restore();
  }

  let rafPending = false;
  function render() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; renderNow(); });
  }

  function renderNow() {
    if (!state.lib || current !== "write") return;
    const wrap = $("paperWrap"), cv = $("paper");
    const pg = pageSpec();
    // on a wide screen, size the page so all of it fits in the window; on a phone it just fills the width
    const avail = wrap.parentElement.clientWidth;
    if (!avail) return;
    let target = Math.min(640, avail);
    if (!narrowMq.matches) target = Math.min(target, Math.max(280, (window.innerHeight - 150) * pg.w / pg.h));
    wrap.style.width = Math.round(target) + "px";
    const cssW = wrap.clientWidth;
    if (!cssW) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.round(cssW * dpr), H = Math.round(cssW * dpr * pg.h / pg.w);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    cur = makeLayout(state.text, true);
    const k = W / pg.w;
    const ctx = cv.getContext("2d");
    drawPage(ctx, k, cur, null);
    if (!state.text) { // a faint placeholder, only on screen
      const ph = makeLayout("Start writing…", true);
      ctx.save(); drawPage(ctx, k, { glyphs: ph.glyphs, ruleYs: [], margin: ph.margin }, { alpha: 0.28 }); ctx.restore();
    }
    const note = $("missingNote");
    if (cur.missing.length) { note.hidden = false; note.textContent = "A few characters aren’t in your handwriting, so they’re skipped: " + cur.missing.slice(0, 8).join(" "); }
    else if (cur.overflow) { note.hidden = false; note.textContent = "That’s a lot of text for one page. Try a larger page or a shorter note."; }
    else note.hidden = true;
    updateCaret();
  }

  // the blinking caret and the selection, drawn over the page (wide screens only)
  function updateCaret() {
    const caret = $("caret"), layer = $("selLayer");
    layer.textContent = "";
    if (narrowMq.matches || !cur) { caret.hidden = true; return; }
    const ta = $("deskText");
    const focused = document.activeElement === ta;
    const wrap = $("paperWrap"), pg = pageSpec();
    const kc = wrap.clientWidth / pg.w;
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) {
      const c = cur.caret[Math.min(s, cur.caret.length - 1)];
      if (!c) { caret.hidden = true; return; }
      caret.hidden = !focused;
      caret.style.color = state.ink;
      caret.style.left = (c.x * kc - 1) + "px";
      caret.style.top = ((c.y - 0.8 * cur.size) * kc) + "px";
      caret.style.height = (1.0 * cur.size * kc) + "px";
      caret.style.animation = "none"; void caret.offsetWidth; caret.style.animation = "";
    } else {
      caret.hidden = true;
      const spans = {};
      for (let i = s; i < e; i++) {
        const c = cur.caret[i], n = cur.caret[i + 1];
        if (!c) continue;
        const x1 = n && n.line === c.line ? n.x : c.x + 0.3 * cur.size;
        const sp = spans[c.line] || (spans[c.line] = { x0: c.x, x1: x1, y: c.y });
        if (c.x < sp.x0) sp.x0 = c.x;
        if (x1 > sp.x1) sp.x1 = x1;
      }
      Object.keys(spans).forEach(function (l) {
        const sp = spans[l];
        const d = document.createElement("div");
        d.className = "sel";
        d.style.left = (sp.x0 * kc) + "px"; d.style.width = Math.max(3, (sp.x1 - sp.x0) * kc) + "px";
        d.style.top = ((sp.y - 0.8 * cur.size) * kc) + "px"; d.style.height = (1.0 * cur.size * kc) + "px";
        layer.appendChild(d);
      });
    }
  }

  function setText(v, from) {
    state.text = v;
    if (from !== "desk" && $("deskText").value !== v) $("deskText").value = v;
    if (from !== "phone" && $("phoneText").value !== v) $("phoneText").value = v;
    render();
    scheduleSave();
  }

  function wireTyping() {
    const ta = $("deskText"), pt = $("phoneText"), wrap = $("paperWrap");
    ta.addEventListener("input", function () { setText(ta.value, "desk"); });
    pt.addEventListener("input", function () { setText(pt.value, "phone"); });
    ["keyup", "focus", "blur", "select"].forEach(function (ev) { ta.addEventListener(ev, updateCaret); });
    document.addEventListener("selectionchange", function () { if (document.activeElement === ta) updateCaret(); });

    // clicking and dragging on the page: map the pointer to the nearest position in the handwriting
    function indexFromEvent(ev) {
      const r = wrap.getBoundingClientRect(), pg = pageSpec();
      return HF.layout.indexAt(cur, (ev.clientX - r.left) * pg.w / r.width, (ev.clientY - r.top) * pg.h / r.height);
    }
    let dragFrom = -1;
    ta.addEventListener("mousedown", function (ev) {
      if (ev.button !== 0 || !cur) return;
      ev.preventDefault();
      ta.focus();
      dragFrom = indexFromEvent(ev);
      ta.setSelectionRange(dragFrom, dragFrom);
      updateCaret();
    });
    window.addEventListener("mousemove", function (ev) {
      if (dragFrom < 0 || !cur) return;
      const i = indexFromEvent(ev);
      ta.setSelectionRange(Math.min(i, dragFrom), Math.max(i, dragFrom), i < dragFrom ? "backward" : "forward");
      updateCaret();
    });
    window.addEventListener("mouseup", function () { dragFrom = -1; });

    // up / down / home / end follow the handwriting's lines, not the hidden text box's
    ta.addEventListener("keydown", function (ev) {
      if (!cur || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const key = ev.key;
      if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "Home" && key !== "End") return;
      const backward = ta.selectionDirection === "backward";
      const focus = backward ? ta.selectionStart : ta.selectionEnd, anchor = backward ? ta.selectionEnd : ta.selectionStart;
      const c = cur.caret[focus];
      let target = focus;
      if (key === "ArrowUp" || key === "ArrowDown") {
        target = HF.layout.indexAt(cur, c.x, c.y + (key === "ArrowDown" ? 1 : -1) * 1.3 * cur.size);
      } else {
        const same = []; cur.caret.forEach(function (q, i) { if (q.line === c.line) same.push(i); });
        target = key === "Home" ? same[0] : same[same.length - 1];
      }
      ev.preventDefault();
      if (ev.shiftKey) ta.setSelectionRange(Math.min(anchor, target), Math.max(anchor, target), target < anchor ? "backward" : "forward");
      else ta.setSelectionRange(target, target);
      updateCaret();
    });

    if (window.ResizeObserver) new ResizeObserver(render).observe(wrap.parentElement);
    window.addEventListener("resize", render);
    narrowMq.addEventListener && narrowMq.addEventListener("change", render);
  }

  // ---------------------------------------------------------------- controls
  function buildSwatches(id, list, key) {
    const box = $(id);
    box.textContent = "";
    list.forEach(function (it) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "swatch"; b.setAttribute("role", "radio");
      b.setAttribute("aria-label", it[0]); b.title = it[0]; b.style.background = it[1]; b.dataset.value = it[1];
      b.addEventListener("click", function () { choose(key, it[1]); });
      box.appendChild(b);
    });
  }
  function choose(key, value) {
    state[key] = value;
    // keep the writing readable: dark ink on a dark page flips to cream, and back
    if (key === "paper" && lum(value) < 0.25 && lum(state.ink) < 0.4) state.ink = "#F6F1E7";
    if (key === "paper" && lum(value) >= 0.25 && lum(state.ink) > 0.85) state.ink = "#14284B";
    syncControls(); render(); scheduleSave();
  }
  function syncControls() {
    [["inkSwatches", "ink"], ["paperSwatches", "paper"]].forEach(function (p) {
      Array.prototype.forEach.call($(p[0]).children, function (b) { b.setAttribute("aria-checked", String(b.dataset.value.toLowerCase() === state[p[1]].toLowerCase())); });
    });
    Array.prototype.forEach.call($("pageSeg").children, function (b) { b.setAttribute("aria-checked", String(b.dataset.value === state.page)); });
    $("linesToggle").checked = state.lines;
    $("sizeRange").value = state.size;
    $("nameInput").value = state.name;
    $("paperWrap").style.background = state.paper;
  }
  function wireControls() {
    buildSwatches("inkSwatches", INKS, "ink");
    buildSwatches("paperSwatches", PAPERS, "paper");
    const seg = $("pageSeg");
    Object.keys(HF.layout.PAGES).forEach(function (k) {
      const b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "radio"); b.dataset.value = k; b.textContent = HF.layout.PAGES[k].label;
      b.addEventListener("click", function () { state.page = k; syncControls(); render(); scheduleSave(); });
      seg.appendChild(b);
    });
    $("linesToggle").addEventListener("change", function (e) { state.lines = e.target.checked; render(); scheduleSave(); });
    $("sizeRange").addEventListener("input", function (e) { state.size = +e.target.value; render(); scheduleSave(); });
    $("nameInput").addEventListener("input", function (e) { state.name = e.target.value.slice(0, 40); fontBytesCache = null; scheduleSave(); });
    $("clearPage").addEventListener("click", function () { setText("", ""); (narrowMq.matches ? $("phoneText") : $("deskText")).focus(); });
    $("redo").addEventListener("click", function () { setupSavedBanner(); show("setup"); });
  }

  // ---------------------------------------------------------------- exports
  function toast(msg) {
    const s = $("status");
    s.textContent = msg;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { s.textContent = ""; }, 3500);
  }
  function safeName() { return HF.fontwriter.sanitizeName(state.name).replace(/[\\/:*?"<>|]/g, "").trim() || "My Handwriting"; }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function pdfBlob() {
    const pg = pageSpec();
    const layout = makeLayout(state.text, true);
    const bytes = HF.pdfwriter.buildPDF({ pageW: pg.w, pageH: pg.h, layout: layout, lib: state.lib, ink: state.ink, paper: state.paper, lines: state.lines, title: safeName() });
    return new Blob([bytes], { type: "application/pdf" });
  }
  function pngBlob() {
    return new Promise(function (resolve) {
      const pg = pageSpec(), k = 3;
      const c = document.createElement("canvas");
      c.width = Math.round(pg.w * k); c.height = Math.round(pg.h * k);
      drawPage(c.getContext("2d"), k, makeLayout(state.text, true), null);
      c.toBlob(resolve, "image/png");
    });
  }
  function fontBytes() {
    const key = state.name;
    if (fontBytesCache && fontBytesCache.key === key && fontBytesCache.lib === state.lib) return fontBytesCache.bytes;
    const bytes = HF.fontwriter.buildTTF({ familyName: state.name, glyphs: state.lib.glyphs, aliases: state.lib.aliases });
    fontBytesCache = { key: key, lib: state.lib, bytes: bytes };
    return bytes;
  }

  function canShareFile(file) { try { return !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { return false; } }
  async function shareFile(file, title) {
    try { await navigator.share({ files: [file], title: title }); return true; }
    catch (e) { return e && e.name === "AbortError"; } // cancelling is fine
  }

  function wireExports() {
    $("savePdf").addEventListener("click", function () {
      try { downloadBlob(pdfBlob(), safeName() + ".pdf"); toast("Saved your PDF."); } catch (e) { toast("Sorry, the PDF didn’t work: " + e.message); }
    });
    $("saveImage").addEventListener("click", async function () {
      try { downloadBlob(await pngBlob(), safeName() + ".png"); toast("Saved your picture."); } catch (e) { toast("Sorry, the picture didn’t work: " + e.message); }
    });
    // Share: sends the picture (works in nearly every messaging app)
    const probe = new File(["x"], "a.png", { type: "image/png" });
    if (canShareFile(probe)) {
      $("sharePage").hidden = false;
      $("sharePage").addEventListener("click", async function () {
        try {
          const blob = await pngBlob();
          const file = new File([blob], safeName() + ".png", { type: "image/png" });
          if (!(await shareFile(file, safeName()))) { downloadBlob(blob, safeName() + ".png"); toast("Saved your picture."); }
        } catch (e) { toast("Sharing didn’t work here. Try Save as image."); }
      });
    }
    $("saveFont").addEventListener("click", function () {
      openFontDialog(!isTouch); // on a computer the download starts right away; on a phone you choose
    });
    $("showHow").addEventListener("click", function () { openFontDialog(false); });
  }

  // ---------------------------------------------------------------- font help dialog
  function setOsTab(os) {
    $("osWin").hidden = os !== "win"; $("osMac").hidden = os !== "mac";
    Array.prototype.forEach.call($("osTabs").children, function (b) { b.setAttribute("aria-selected", String(b.dataset.os === os)); });
  }
  function downloadFont() {
    downloadBlob(new Blob([fontBytes()], { type: "font/ttf" }), HF.fontwriter.fileNameFor(state.name));
  }
  function openFontDialog(autoDownload) {
    const dlg = $("fontDlg");
    const name = HF.fontwriter.fileNameFor(state.name);
    $("dlgTitle").textContent = autoDownload ? "Your font is downloading" : "Use your handwriting as a font";
    $("dlgSub").textContent = "File: " + name;
    $("dlgPhoneNote").hidden = !isTouch;
    const ua = navigator.userAgent || "";
    setOsTab(/Mac|iPhone|iPad/.test(ua) && !/Windows/.test(ua) ? "mac" : "win");
    let bytes = null;
    try { bytes = fontBytes(); } catch (e) { toast("Sorry, the font didn’t build: " + e.message); return; }
    const file = new File([bytes], name, { type: "font/ttf" });
    $("dlgShare").hidden = !canShareFile(file);
    if (autoDownload) downloadFont();
    if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute("open", "");
  }
  function wireDialog() {
    $("dlgClose").addEventListener("click", function () { $("fontDlg").close ? $("fontDlg").close() : $("fontDlg").removeAttribute("open"); });
    $("fontDlg").addEventListener("click", function (e) { if (e.target === $("fontDlg") && $("fontDlg").close) $("fontDlg").close(); });
    $("dlgDownload").addEventListener("click", function () { try { downloadFont(); toast("Font saved."); } catch (e) { toast("Sorry: " + e.message); } });
    $("dlgShare").addEventListener("click", async function () {
      const name = HF.fontwriter.fileNameFor(state.name);
      const file = new File([fontBytes()], name, { type: "font/ttf" });
      if (!(await shareFile(file, state.name))) downloadFont();
    });
    Array.prototype.forEach.call($("osTabs").children, function (b) { b.addEventListener("click", function () { setOsTab(b.dataset.os); }); });
  }

  // ---------------------------------------------------------------- entering the write screen
  async function loadFontFace() { // lets the phone's text box show your handwriting as you type
    try {
      if (!window.FontFace) return;
      const ff = new FontFace("HFHand", fontBytes().slice().buffer);
      await ff.load();
      if (fontFace) document.fonts.delete(fontFace);
      document.fonts.add(ff); fontFace = ff;
      $("phoneText").style.fontFamily = "'HFHand', system-ui, sans-serif";
    } catch (e) { /* the box just keeps the normal font */ }
  }

  function enterWrite() {
    paths = {}; fontBytesCache = null;
    show("write");
    syncControls();
    $("deskText").value = state.text; $("phoneText").value = state.text;
    renderNow();
    loadFontFace();
    if (!isTouch && !narrowMq.matches) setTimeout(function () { $("deskText").focus(); updateCaret(); }, 60);
  }

  // ---------------------------------------------------------------- start up
  function wireIntake() {
    const drop = $("drop");
    if (isTouch) $("btnCamera").hidden = false;
    $("dropHint").textContent = isTouch ? "Take a photo of your page, or pick one from your photos." : "Drop your photo here, paste it (Ctrl+V), or choose a file.";
    function pick(input) { input.value = ""; input.click(); }
    $("btnCamera").addEventListener("click", function () { pick($("fileCamera")); });
    $("btnChoose").addEventListener("click", function () { pick($("fileChoose")); });
    ["fileCamera", "fileChoose"].forEach(function (id) { $(id).addEventListener("change", function (e) { processFile(e.target.files[0]); }); });
    ["anotherPhoto1", "anotherPhoto2"].forEach(function (id) { $(id).addEventListener("click", function () { pick($("fileChoose")); }); });
    $("backToSetup").addEventListener("click", function () { setupSavedBanner(); show("setup"); });

    ["dragenter", "dragover"].forEach(function (ev) { document.addEventListener(ev, function (e) { if (current === "write") return; e.preventDefault(); drop.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { document.addEventListener(ev, function (e) { if (current === "write") return; e.preventDefault(); drop.classList.remove("over"); }); });
    document.addEventListener("drop", function (e) {
      if (current === "write") return;
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) processFile(f);
    });
    document.addEventListener("paste", function (e) {
      if (current === "write") return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (let i = 0; i < items.length; i++) if (items[i].type.indexOf("image/") === 0) { processFile(items[i].getAsFile()); e.preventDefault(); return; }
    });

    $("trySample").addEventListener("click", function () {
      function go() {
        const b = atob(window.HF_SAMPLE.split(",")[1]);
        const bytes = new Uint8Array(b.length);
        for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
        processFile(new File([bytes], "sample-sheet.jpg", { type: "image/jpeg" }));
      }
      if (window.HF_SAMPLE) return go();
      const s = document.createElement("script");
      s.src = "src/sample.js"; s.onload = go;
      s.onerror = function () { showReview(friendly("I couldn’t load the sample sheet.", "Please check your connection, or use your own photo.")); show("review"); };
      document.head.appendChild(s);
    });

    $("startWriting").addEventListener("click", function () {
      if (!state.pending) return;
      state.lib = state.pending; state.pending = null;
      state.name = HF.fontwriter.sanitizeName($("fontName").value);
      saveNow();
      enterWrite();
    });
    $("backToWriting").addEventListener("click", enterWrite);
    $("topBack").addEventListener("click", enterWrite);
  }

  function init() {
    renderList();
    const saved = loadSaved();
    if (saved) {
      state.lib = saved.lib; state.name = saved.name || state.name;
      state.ink = saved.ink || state.ink; state.paper = saved.paper || state.paper;
      state.lines = !!saved.lines; state.page = HF.layout.PAGES[saved.page] ? saved.page : "card";
      state.size = saved.size || 5; state.text = typeof saved.text === "string" ? saved.text : SAMPLE_NOTE;
    }
    if (FEEDBACK_URL) $("feedbackLink").href = FEEDBACK_URL; else $("feedbackLink").parentElement.hidden = true;
    wireIntake(); wireControls(); wireTyping(); wireExports(); wireDialog();
    setupSavedBanner();
    if (state.lib) enterWrite(); else show("setup"); // a return visit goes straight to writing
  }

  init();
})();
